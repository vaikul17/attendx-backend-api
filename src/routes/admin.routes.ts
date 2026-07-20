import { Router } from 'express';
import { verifyAdminToken } from '../middleware/auth.middleware';
import {
  loginAdmin,
  getDashboardStats,
  getEmployeesList,
  deleteEmployee,
  resetFaceEmbeddings,
  getAttendanceLogs,
  adjustAttendanceLog,
  getGeofenceSettings,
  saveGeofenceSettings,
  exportAttendanceExcel,
  getSelfieRecord,
  changeAdminSecretCode,
} from '../controllers/admin.controller';

const router = Router();

// Public login endpoint
router.post('/login', loginAdmin);

// Protected Admin dashboard and management endpoints
router.get('/stats', verifyAdminToken, getDashboardStats);
router.get('/employees', verifyAdminToken, getEmployeesList);
router.delete('/employees/:id', verifyAdminToken, deleteEmployee);
router.post('/employees/:id/reset', verifyAdminToken, resetFaceEmbeddings);
router.get('/attendance', verifyAdminToken, getAttendanceLogs);
router.post('/attendance/adjust', verifyAdminToken, adjustAttendanceLog);
router.get('/settings', verifyAdminToken, getGeofenceSettings);
router.post('/settings', verifyAdminToken, saveGeofenceSettings);
router.get('/selfie/:id', verifyAdminToken, getSelfieRecord);
router.post('/change-secret-code', verifyAdminToken, changeAdminSecretCode);

// Excel Export is protected
router.get('/attendance/export', verifyAdminToken, exportAttendanceExcel);

export default router;
