import { PrismaClient } from '@prisma/client';
import { ensureDatabaseUrlForRuntime } from '../utils/statePaths';

ensureDatabaseUrlForRuntime();
export const prisma = new PrismaClient();
