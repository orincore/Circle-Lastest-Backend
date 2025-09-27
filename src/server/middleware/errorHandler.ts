import type { NextFunction, Request, Response } from 'express'
import { StatusCodes, getReasonPhrase } from 'http-status-codes'

export function notFound(_req: Request, res: Response) {
  res.status(StatusCodes.NOT_FOUND).json({ error: 'Not Found' })
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status || StatusCodes.INTERNAL_SERVER_ERROR
  const message = err.message || getReasonPhrase(status)
  const details = err.details
  res.status(status).json({ error: message, details })
}
