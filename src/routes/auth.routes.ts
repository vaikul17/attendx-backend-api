import { Router } from 'express';
import multer from 'multer';
import { register, login, checkRegistration, prewarm, verifyEntry, login1to1 } from '../controllers/auth.controller';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Unified Entry verification (Admin secret code OR Employee mobile)
router.post('/verify-entry', verifyEntry);

// 1:1 Face Verification Login
router.post('/login-1to1', upload.single('image'), login1to1);

// Route to check if phone is already registered
router.post('/check-phone', checkRegistration);

// Pre-warm Face AI service
router.get('/prewarm', prewarm);

// Multi-part route to capture profile details & register face embeddings
router.post('/register', upload.single('image'), register);

// Login with Face scan (legacy N:1)
router.post('/login', upload.single('image'), login);

export default router;
