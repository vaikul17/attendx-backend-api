import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 1. Perform Punch In
export async function punchIn(req: Request, res: Response) {
  const { employeeId, latitude, longitude, gpsAccuracy, selfieBase64, deviceInfo, browserInfo } = req.body;

  if (!employeeId || !selfieBase64 || !latitude || !longitude) {
    return res.status(400).json({ error: 'Missing required punch-in details (selfie, coordinates).' });
  }

  try {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const accuracy = parseFloat(gpsAccuracy || '10.0');
    
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Check duplicate punch-in
    const existing = await prisma.attendance.findFirst({
      where: { employeeId, date: todayStr },
    });

    if (existing && existing.punchIn) {
      return res.status(400).json({ error: 'Already punched in today.' });
    }

    // Save attendance log
    const attendance = await prisma.attendance.upsert({
      where: {
        id: existing?.id || 'new_id',
      },
      update: {
        punchIn: now,
        punchInLat: lat,
        punchInLng: lng,
        status: 'Present',
        deviceInfo,
        browserInfo,
      },
      create: {
        employeeId,
        date: todayStr,
        punchIn: now,
        punchInLat: lat,
        punchInLng: lng,
        status: 'Present',
        deviceInfo,
        browserInfo,
      },
    });

    // Save verification photo
    await prisma.verificationSelfie.create({
      data: {
        employeeId,
        imageBytes: selfieBase64,
        latitude: lat,
        longitude: lng,
        gpsAccuracy: accuracy,
        type: 'IN',
        timestamp: now,
      },
    });

    return res.json({
      success: true,
      message: 'Punch-In Successful',
      time: now.toISOString(),
      date: todayStr,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Database punch-in save failed: ' + err });
  }
}

// 2. Perform Punch Out
export async function punchOut(req: Request, res: Response) {
  const { employeeId, latitude, longitude, gpsAccuracy, selfieBase64, deviceInfo, browserInfo } = req.body;

  if (!employeeId || !selfieBase64 || !latitude || !longitude) {
    return res.status(400).json({ error: 'Missing required punch-out details (selfie, coordinates).' });
  }

  try {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const accuracy = parseFloat(gpsAccuracy || '10.0');

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    const attendance = await prisma.attendance.findFirst({
      where: { employeeId, date: todayStr },
    });

    if (!attendance || !attendance.punchIn) {
      return res.status(400).json({ error: 'You must punch in first.' });
    }

    if (attendance.punchOut) {
      return res.status(400).json({ error: 'Already punched out today.' });
    }

    // Update attendance log
    await prisma.attendance.update({
      where: { id: attendance.id },
      data: {
        punchOut: now,
        punchOutLat: lat,
        punchOutLng: lng,
        deviceInfo,
        browserInfo,
      },
    });

    // Save verification photo
    await prisma.verificationSelfie.create({
      data: {
        employeeId,
        imageBytes: selfieBase64,
        latitude: lat,
        longitude: lng,
        gpsAccuracy: accuracy,
        type: 'OUT',
        timestamp: now,
      },
    });

    return res.json({
      success: true,
      message: 'Punch-Out Successful',
      time: now.toISOString(),
      date: todayStr,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Database punch-out save failed: ' + err });
  }
}

// 3. Get Employee's Attendance History and Monthly Counts
export async function getHistory(req: Request, res: Response) {
  const { employeeId } = req.params;

  if (!employeeId) {
    return res.status(400).json({ error: 'Employee ID is required.' });
  }

  try {
    // Fetch logs
    const history = await prisma.attendance.findMany({
      where: { employeeId },
      orderBy: { date: 'desc' },
      take: 90,
    });

    // Compute monthly summaries
    const now = new Date();
    const currentMonth = now.getMonth(); // 0-11
    const currentYear = now.getFullYear();

    const monthlyLogs = history.filter((log) => {
      const logDate = new Date(log.date);
      return logDate.getMonth() === currentMonth && logDate.getFullYear() === currentYear;
    });

    const presentCount = monthlyLogs.filter((log) => log.status === 'Present').length;
    const absentCount = monthlyLogs.filter((log) => log.status === 'Absent').length;
    const holidayCount = monthlyLogs.filter((log) => log.status === 'Holiday').length;
    const sundayCount = monthlyLogs.filter((log) => log.status === 'Sunday').length;

    const denom = presentCount + absentCount;
    const attendancePercentage = denom > 0 ? Math.round((presentCount / denom) * 100) : 100;

    return res.json({
      history,
      stats: {
        presentCount,
        absentCount,
        holidayCount,
        sundayCount,
        attendancePercentage,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch logs: ' + err });
  }
}
