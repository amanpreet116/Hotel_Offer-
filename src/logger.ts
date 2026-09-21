import pino from 'pino';
import { config } from './config/index.js';

export const logger = pino({
  level: config.logger.level,
  base: { service: 'hotel-offer-orchestrator' },
  ...(config.isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }),
});

export type Logger = typeof logger;
