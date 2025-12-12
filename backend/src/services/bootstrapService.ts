import { prisma } from '../db/client';
import { hashPassword } from './passwordService';

export async function ensureAdminUser(): Promise<void> {
  const userCount = await prisma.user.count();

  if (userCount > 0) {
    return;
  }

  const passwordHash = await hashPassword('admin123');

  await prisma.user.create({
    data: {
      name: 'Admin',
      email: 'admin@example.com',
      passwordHash,
      role: 'ADMIN'
    }
  });
}
