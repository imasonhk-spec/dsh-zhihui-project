import 'dotenv/config'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

export const objectStorage = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:59000',
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE ? process.env.S3_FORCE_PATH_STYLE === 'true' : true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  },
})

export const objectStorageBucket = () => process.env.S3_BUCKET ?? 'project-manager'
const maxObjectBytes = () => Number(process.env.S3_MAX_OBJECT_BYTES ?? 20 * 1024 * 1024)

export async function ensureObjectStorageBucket(): Promise<void> {
  try {
    await objectStorage.send(new HeadBucketCommand({ Bucket: objectStorageBucket() }))
  } catch (error) {
    const status = error && typeof error === 'object' && '$metadata' in error ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined
    const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : ''
    if (status !== 404 && name !== 'NotFound' && name !== 'NoSuchBucket') throw error
    await objectStorage.send(new CreateBucketCommand({ Bucket: objectStorageBucket() }))
  }
}

export async function checkObjectStorage(): Promise<boolean> {
  try {
    await objectStorage.send(new HeadBucketCommand({ Bucket: objectStorageBucket() }))
    return true
  } catch {
    return false
  }
}

export function buildKnowledgeObjectKey(projectId: string, documentId: string, versionId: string) {
  return `projects/${projectId}/knowledge/${documentId}/versions/${versionId}`
}

export async function putKnowledgeObject(input: { key: string; body: Buffer | Uint8Array | Readable; contentType?: string; contentLength: number }) {
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0 || input.contentLength > maxObjectBytes()) throw new Error('knowledge_file_size_invalid')
  await objectStorage.send(new PutObjectCommand({ Bucket: objectStorageBucket(), Key: input.key, Body: input.body, ContentType: input.contentType, ContentLength: input.contentLength }))
  return { key: input.key, size: input.contentLength }
}

export async function getKnowledgeObject(key: string) {
  const response = await objectStorage.send(new GetObjectCommand({ Bucket: objectStorageBucket(), Key: key }))
  return { body: response.Body, contentLength: response.ContentLength ?? null, contentType: response.ContentType ?? null, etag: response.ETag ?? null }
}

export async function knowledgeObjectExists(key: string) {
  try {
    await objectStorage.send(new HeadObjectCommand({ Bucket: objectStorageBucket(), Key: key }))
    return true
  } catch (error) {
    const status = error && typeof error === 'object' && '$metadata' in error ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined
    if (status === 404) return false
    throw error
  }
}

export async function deleteKnowledgeObject(key: string) {
  await objectStorage.send(new DeleteObjectCommand({ Bucket: objectStorageBucket(), Key: key }))
}

export function checksumSha256(value: Buffer | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}
