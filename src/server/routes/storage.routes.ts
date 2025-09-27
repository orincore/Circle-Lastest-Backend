import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { s3 } from '../config/s3.js'
import { env } from '../config/env.js'

const router = Router()

const presignSchema = z.object({
  contentType: z.string(),
  key: z.string().min(1)
})

router.post('/presign-upload', requireAuth, async (req, res) => {
  if (!s3 || !env.AWS_S3_BUCKET) {
    return res.status(503).json({ error: 'Storage not configured' })
  }
  const parse = presignSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: 'Invalid body', details: parse.error.flatten() })
  const { key, contentType } = parse.data

  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: 'private'
  })
  const url = await getSignedUrl(s3, command, { expiresIn: 60 })
  return res.json({ url, key, bucket: env.AWS_S3_BUCKET })
})

export default router
