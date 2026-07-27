import winston from 'winston';

const logsDir = './logs/';

const loggerLevel = process.env.logLevel || 'info';

const terminalFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack }) => {
    const upper = level.toUpperCase();
    const importantTag = level === 'error' || level === 'warn' ? '[IMPORTANT]' : '';
    const base = `[${timestamp}] [${upper}] ${importantTag} ${message}`.trim();

    return stack ? `${base}\n${stack}` : base;
  }),
);

export const logger = winston.createLogger({
  level: loggerLevel,
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      level: loggerLevel,
      stderrLevels: ['warn', 'error'],
      format: terminalFormat,
    }),
    new winston.transports.File({
      filename: `${logsDir}error.log`,
      level: 'error',
    }),
  ],
});
