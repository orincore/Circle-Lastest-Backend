/**
 * Cashfree Payment Gateway Configuration
 * Using direct API calls with axios
 */

import axios from 'axios';

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  environment: 'sandbox' | 'production';
  apiVersion: string;
  baseUrl: string;
}

export const cashfreeConfig: CashfreeConfig = {
  appId: process.env.CASHFREE_APP_ID || '',
  secretKey: process.env.CASHFREE_SECRET_KEY || '',
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
  apiVersion: '2023-08-01',
  baseUrl: process.env.NODE_ENV === 'production' 
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg'
};

// Validate configuration
export const validateCashfreeConfig = (): boolean => {
  if (!cashfreeConfig.appId || !cashfreeConfig.secretKey) {
    console.error('❌ Cashfree configuration missing! Please set CASHFREE_APP_ID and CASHFREE_SECRET_KEY in .env');
    return false;
  }
  return true;
};

// Create Cashfree API client
export const cashfreeClient = axios.create({
  baseURL: cashfreeConfig.baseUrl,
  headers: {
    'x-client-id': cashfreeConfig.appId,
    'x-client-secret': cashfreeConfig.secretKey,
    'x-api-version': cashfreeConfig.apiVersion,
    'Content-Type': 'application/json'
  }
});

export default cashfreeConfig;
