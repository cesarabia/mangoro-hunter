import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { verifyPassword } from '../services/passwordService';

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/login', async (request, reply) => {
    try {
      const { email, password } = request.body as { email: string; password: string };

      if (!email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const isValid = await verifyPassword(password, user.passwordHash);
      if (!isValid) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const token = app.jwt.sign({ userId: user.id, role: user.role });
      return { token };
    } catch (err) {
      app.log.error({ err }, 'Login failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
