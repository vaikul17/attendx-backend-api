import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import FormData from 'form-data';

const prisma = new PrismaClient();
const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://face_service:8000';

// Haversine Distance helper
export function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Radius of Earth in meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 1. Check if user already registered face using Phone
export async function checkRegistration(req: Request, res: Response) {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  try {
    const employee = await prisma.employee.findUnique({
      where: { phone },
      include: { embeddings: true },
    });

    if (employee && employee.embeddings.length > 0) {
      return res.json({ exists: true, employeeId: employee.id, name: employee.name });
    }
    return res.json({ exists: false });
  } catch (err) {
    return res.status(500).json({ error: 'Server database error check: ' + err });
  }
}

// 2. Perform Biometric + Profile Registration
export async function register(req: Request, res: Response) {
  const { name, phone } = req.body;
  const file = req.file;

  if (!name || !phone || !file) {
    return res.status(400).json({ error: 'Name, phone number, and face image file are required.' });
  }

  try {
    // Check if employee phone number already exists
    const existing = await prisma.employee.findUnique({
      where: { phone },
      include: { embeddings: true },
    });

    if (existing && existing.embeddings.length > 0) {
      return res.status(400).json({ error: 'Phone number already registered with face biometrics.' });
    }

    // Call Python Face AI to extract face embeddings
    const form = new FormData();
    form.append('image', file.buffer, {
      filename: 'register.jpg',
      contentType: file.mimetype,
    });

    const response = await axios.post(`${FACE_SERVICE_URL}/embed`, form, {
      headers: form.getHeaders(),
    });

    const embedding: number[] = response.data.embedding;

    let employeeId = '';

    if (existing) {
      // Re-register: Employee profile exists but has no face embeddings (reset by admin)
      await prisma.faceEmbedding.create({
        data: {
          employeeId: existing.id,
          embedding: JSON.stringify(embedding),
        },
      });
      employeeId = existing.id;
      console.log(`[INFO] Re-registered face for existing employee: ${existing.name} (ID: ${existing.id})`);
    } else {
      // Brand new registration
      const employee = await prisma.employee.create({
        data: {
          name,
          phone,
          embeddings: {
            create: {
              embedding: JSON.stringify(embedding),
            },
          },
        },
      });
      employeeId = employee.id;
      console.log(`[INFO] Registered new employee: ${name} (ID: ${employee.id})`);
    }

    return res.json({
      success: true,
      message: 'Registration successful. You may now login.',
      employeeId,
    });
  } catch (err: any) {
    console.error('Registration failed: ', err.response?.data || err.message);
    const detail = err.response?.data?.detail || err.message;
    return res.status(400).json({ error: `Face extraction failed: ${detail}` });
  }
}

// 3. User face login validation
export async function login(req: Request, res: Response) {
  const file = req.file;
  const { latitude, longitude } = req.body;

  if (!file) {
    return res.status(400).json({ error: 'Webcam snapshot image required.' });
  }

  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'GPS coordinates required for verification.' });
  }

  try {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    // 1. Geofence checks
    const settings = await prisma.settings.findUnique({
      where: { id: 'global_settings' },
    });
    if (!settings) {
      return res.status(500).json({ error: 'Settings not configured on server.' });
    }

    const dist = getDistance(lat, lng, settings.latitude, settings.longitude);
    if (dist > settings.radiusMeters) {
      return res.status(400).json({
        error: `You are outside office premises. Attendance cannot be marked. Distance: ${dist.toFixed(1)}m (Allowed: ${settings.radiusMeters}m)`,
      });
    }

    // 2. Query all database face embeddings
    const allEmbeddings = await prisma.faceEmbedding.findMany({
      include: { employee: true },
    });

    if (allEmbeddings.length === 0) {
      return res.status(400).json({ error: 'No registered face records found in DB.' });
    }

    // Get scanned face embedding from Python Face AI
    const form = new FormData();
    form.append('image', file.buffer, {
      filename: 'login.jpg',
      contentType: file.mimetype,
    });

    const embedResponse = await axios.post(`${FACE_SERVICE_URL}/embed`, form, {
      headers: form.getHeaders(),
    });

    const scannedEmbedding: number[] = embedResponse.data.embedding;

    // Send comparison arrays to Python Face AI
    const matchForm = new FormData();
    matchForm.append('scanned_embedding_json', JSON.stringify(scannedEmbedding));
    
    // Prepare known array
    const knownData = allEmbeddings.map((item) => ({
      employeeId: item.employeeId,
      embedding: JSON.parse(item.embedding),
    }));
    matchForm.append('known_embeddings_json', JSON.stringify(knownData));

    const matchResponse = await axios.post(`${FACE_SERVICE_URL}/match`, matchForm, {
      headers: matchForm.getHeaders(),
    });

    const { match, employeeId, confidence } = matchResponse.data;

    if (!match || !employeeId) {
      return res.status(401).json({ error: 'Face Not Recognized. Please Contact Administrator.' });
    }

    // Fetch matched employee information
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      return res.status(401).json({ error: 'Profile matching face not found.' });
    }

    // Fetch today's punch state
    const todayStr = new Date().toISOString().split('T')[0];
    const attendance = await prisma.attendance.findFirst({
      where: { employeeId: employee.id, date: todayStr },
    });

    return res.json({
      success: true,
      employeeId: employee.id,
      name: employee.name,
      confidence,
      punchIn: attendance?.punchIn ? attendance.punchIn.toISOString() : null,
      punchOut: attendance?.punchOut ? attendance.punchOut.toISOString() : null,
      minHours: settings.minHoursBeforePunchOut,
    });
  } catch (err: any) {
    console.error('Login match failed: ', err.response?.data || err.message);
    const detail = err.response?.data?.detail || err.message;
    return res.status(400).json({ error: `Face verification failed: ${detail}` });
  }
}
