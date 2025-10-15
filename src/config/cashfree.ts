/**
 * Cashfree Payment Gateway Configuration
 */

import { Cashfree } from 'cashfree-pg';

// Initialize Cashfree SDK
const cashfreeEnv = process.env.NODE_ENV === 'production' 
  ? Cashfree.Environment.PRODUCTION 
  : Cashfree.Environment.SANDBOX;

Cashfree.XClientId = process.env.CASHFREE_APP_ID || '';
Cashfree.XClientSecret = process.env.CASHFREE_SECRET_KEY || '';
Cashfree.XEnvironment = cashfreeEnv;

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  environment: 'sandbox' | 'production';
  apiVersion: string;
}

export const cashfreeConfig: CashfreeConfig = {
  appId: process.env.CASHFREE_APP_ID || '',
  secretKey: process.env.CASHFREE_SECRET_KEY || '',
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
  apiVersion: '2023-08-01'
};

// Validate configuration
export const validateCashfreeConfig = (): boolean => {
  if (!cashfreeConfig.appId || !cashfreeConfig.secretKey) {
    console.error('❌ Cashfree configuration missing! Please set CASHFREE_APP_ID and CASHFREE_SECRET_KEY in .env');
    return false;
  }
  return true;
};

export { Cashfree };
export default cashfreeConfig;
