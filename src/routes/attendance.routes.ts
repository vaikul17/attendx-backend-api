import { Router } from 'express';
import { punchIn, punchOut, getHistory } from '../controllers/attendance.controller';

const router = Router();

// Perform Punch In (requires face verification selfie + geolocation coordinates)
router.post('/punch-in', punchIn);

// Perform Punch Out (requires face verification selfie + geolocation coordinates)
router.post('/punch-out', punchOut);

// Fetch Employee attendance history and monthly summary percentages
router.get('/history/:employeeId', getHistory);

export default router;
