import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AdminRequest extends Request {
  adminId?: string;
  adminRole?: string;
}

export function verifyAdminToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access Denied. JWT Token missing.' });
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforattendxapp';
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; role: string };
    
    (req as AdminRequest).adminId = decoded.id;
    (req as AdminRequest).adminRole = decoded.role;
    
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Session expired or invalid token.' });
  }
}
