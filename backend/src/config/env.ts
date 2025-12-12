import dotenv from 'dotenv';
import path from 'path';

const defaultEnvPath = path.resolve(__dirname, '../../../.env');
dotenv.config({ path: process.env.TALENT_HUNTER_ENV_PATH || defaultEnvPath });

export const env = {
  port: Number(process.env.PORT || 4001),
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  openAIApiKey: process.env.OPENAI_API_KEY || ''
};
