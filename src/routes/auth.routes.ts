import { Router } from 'express';
import multer from 'multer';
import { register, login, checkRegistration, prewarm } from '../controllers/auth.controller';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Route to check if phone is already registered
router.post('/check-phone', checkRegistration);

// Pre-warm Face AI service
router.get('/prewarm', prewarm);

// Multi-part route to capture profile details & register face embeddings
router.post('/register', upload.single('image'), register);

// Login with Face scan
router.post('/login', upload.single('image'), login);

export default router;
