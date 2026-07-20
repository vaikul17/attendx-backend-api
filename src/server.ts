import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import attendanceRoutes from './routes/attendance.routes';
import adminRoutes from './routes/admin.routes';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Register routes
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/admin', adminRoutes);

// Seed Admin Account & Default Settings
async function seedData() {
  try {
    // 1. Seed global settings
    const settings = await prisma.settings.findUnique({
      where: { id: 'global_settings' },
    });
    if (!settings) {
      await prisma.settings.create({
        data: {
          id: 'global_settings',
          officeName: 'AttendX HQ',
          latitude: 21.125184,
          longitude: 79.063881,
          radiusMeters: 50.0,
          minHoursBeforePunchOut: 8.0,
        },
      });
      console.log('[SEED] Global Settings created.');
    }

    // 2. Seed default admin account
    const adminCount = await prisma.admin.count();
    const defaultSecret = process.env.ADMIN_SECRET_CODE || 'admin123';
    const secretHash = await bcrypt.hash(defaultSecret, 10);
    const passHash = await bcrypt.hash('admin123', 10);

    if (adminCount === 0) {
      await prisma.admin.create({
        data: {
          username: 'admin',
          passwordHash: passHash,
          secretCodeHash: secretHash,
          role: 'ADMIN',
        },
      });
      console.log('[SEED] Admin user seeded with Secret Code.');
    } else {
      // Ensure existing admin record has secretCodeHash set
      const admin = await prisma.admin.findFirst();
      if (admin && (!admin.secretCodeHash || admin.secretCodeHash === '')) {
        await prisma.admin.update({
          where: { id: admin.id },
          data: { secretCodeHash: secretHash },
        });
        console.log('[SEED] Updated existing admin with Secret Code hash.');
      }
    }
  } catch (err) {
    console.error('[SEED ERROR] Seeding aborted: ', err);
  }
}

app.listen(PORT, async () => {
  console.log(`[SERVER] AttendX Backend API listening on http://localhost:${PORT}`);
  await seedData();
});
