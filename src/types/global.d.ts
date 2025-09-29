// Global type declarations for modules without TypeScript definitions

declare module 'compression' {
  import { RequestHandler } from 'express';
  function compression(): RequestHandler;
  export = compression;
}

declare module 'bcryptjs' {
  export function hash(data: string, saltOrRounds: string | number): Promise<string>;
  export function compare(data: string, encrypted: string): Promise<boolean>;
  export function genSalt(rounds?: number): Promise<string>;
  export function hashSync(data: string, saltOrRounds: string | number): string;
  export function compareSync(data: string, encrypted: string): boolean;
  export function genSaltSync(rounds?: number): string;
}

declare module 'jsonwebtoken' {
  export interface SignOptions {
    algorithm?: string;
    expiresIn?: string | number;
    notBefore?: string | number;
    audience?: string | string[];
    subject?: string;
    issuer?: string;
    jwtid?: string;
    mutatePayload?: boolean;
    noTimestamp?: boolean;
    header?: object;
    keyid?: string;
  }

  export interface VerifyOptions {
    algorithms?: string[];
    audience?: string | RegExp | (string | RegExp)[];
    clockTolerance?: number;
    complete?: boolean;
    issuer?: string | string[];
    ignoreExpiration?: boolean;
    ignoreNotBefore?: boolean;
    jwtid?: string;
    nonce?: string;
    subject?: string | string[];
    clockTimestamp?: number;
    maxAge?: string | number;
  }

  export function sign(
    payload: string | Buffer | object,
    secretOrPrivateKey: string | Buffer,
    options?: SignOptions
  ): string;

  export function verify(
    token: string,
    secretOrPublicKey: string | Buffer,
    options?: VerifyOptions
  ): any;

  export class JsonWebTokenError extends Error {
    name: 'JsonWebTokenError';
  }

  export class TokenExpiredError extends JsonWebTokenError {
    name: 'TokenExpiredError';
    expiredAt: Date;
  }

  export class NotBeforeError extends JsonWebTokenError {
    name: 'NotBeforeError';
    date: Date;
  }
}
