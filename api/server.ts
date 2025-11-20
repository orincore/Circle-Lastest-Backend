import type { VercelRequest, VercelResponse } from '@vercel/node'
import { prepareApp } from '../src/server/bootstrap.js'

let cachedHandler: (req: VercelRequest, res: VercelResponse) => void | Promise<void>

async function getHandler() {
  if (!cachedHandler) {
    const app = await prepareApp()
    cachedHandler = (req, res) => app(req as any, res as any)
  }

  return cachedHandler
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  process.env.SERVER_RUNTIME = 'vercel'
  const appHandler = await getHandler()
  return appHandler(req, res)
}
