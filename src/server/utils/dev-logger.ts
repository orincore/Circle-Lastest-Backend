/**
 * Development Logger Utility
 * Defaults to production mode (no logs) if NODE_ENV is not set
 * Only logs when NODE_ENV is explicitly set to 'development'
 */

// Default to production if NODE_ENV is not set
const isDevelopment = process.env.NODE_ENV === 'development';
const isDebugEnabled = process.env.DEBUG === 'true';

/**
 * Log only in development (silent by default)
 */
export const devLog = (...args: any[]) => {
  if (isDevelopment) {
    console.log(...args);
  }
};

/**
 * Debug log (requires DEBUG=true and development mode)
 */
export const devDebug = (...args: any[]) => {
  if (isDevelopment && isDebugEnabled) {
    console.debug(...args);
  }
};

/**
 * Warning log (shown only in development)
 */
export const devWarn = (...args: any[]) => {
  if (isDevelopment) {
    console.warn(...args);
  }
};

/**
 * Error log (always shown - critical errors)
 */
export const logError = console.error;

/**
 * Production-safe logger
 * All methods are silent by default unless NODE_ENV=development
 */
export const prodLog = {
  info: devLog,
  debug: devDebug,
  warn: devWarn,
  error: logError
};
