import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';
import * as ccxt from 'ccxt';

export const getCcxtProxy = (name: string, exchange: string): string | undefined =>
  process.env[`${name}_${exchange.toUpperCase()}`]?.trim() || process.env[name]?.trim();

const fetchWithRetry = async (url: RequestInfo, init?: RequestInit): Promise<Response> => {
  const retryable = !init?.method || init.method.toUpperCase() === 'GET';
  const maximumAttempts = retryable ? 3 : 1;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt === maximumAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }

  throw new Error('CCXT fetch retry loop exited unexpectedly');
};

export const configureCcxtTransport = (exchange: ccxt.Exchange): void => {
  exchange.fetchImplementation = fetchWithRetry;
};