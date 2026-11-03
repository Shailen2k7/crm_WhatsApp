/**
 * Pictures and files for chat: what may be sent, how big pictures get before
 * they go up, and the labels the screens show.
 */
import type { ChatAttachment } from '../types'

export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_FILES_PER_MESSAGE = 10
/** a picture bigger than this is re-encoded on the device (which also drops hidden metadata) */
const PICTURE_RESIZE_OVER_BYTES = 1.5 * 1024 * 1024
const PICTURE_MAX_EDGE = 2000

export const isPicture = (type: string) => /^image\/(jpeg|png|gif|webp|heic|heif|avif|bmp)$/i.test(type)

export const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** "Photo", "2 photos", "report.pdf", "3 files" — for previews and notifications */
export const attachmentsLabel = (list: Pick<ChatAttachment, 'name' | 'type'>[] | number) => {
  if (typeof list === 'number') return list === 1 ? '📎 Attachment' : `📎 ${list} attachments`
  const pics = list.filter((a) => isPicture(a.type)).length
  const files = list.length - pics
  if (list.length === 1) return pics ? '📷 Photo' : `📎 ${list[0].name}`
  if (!files) return `📷 ${pics} photos`
  if (!pics) return `📎 ${files} files`
  return `📎 ${list.length} attachments`
}

/** a short kind for the file chip icon */
export const fileKind = (a: Pick<ChatAttachment, 'name' | 'type'>): 'pdf' | 'doc' | 'sheet' | 'slides' | 'zip' | 'video' | 'audio' | 'file' => {
  const t = a.type.toLowerCase()
  const ext = (a.name.split('.').pop() ?? '').toLowerCase()
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (/word|officedocument\.wordprocessing|rtf/.test(t) || ['doc', 'docx', 'rtf', 'odt', 'pages'].includes(ext)) return 'doc'
  if (/excel|spreadsheet|csv/.test(t) || ['xls', 'xlsx', 'csv', 'numbers', 'ods'].includes(ext)) return 'sheet'
  if (/powerpoint|presentation/.test(t) || ['ppt', 'pptx', 'key', 'odp'].includes(ext)) return 'slides'
  if (/zip|compressed|tar|gzip|rar|7z/.test(t) || ['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'zip'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  return 'file'
}

const loadImage = (blob: Blob): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })

const safeName = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[^\w.\- ()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file'

export interface PreparedFile {
  blob: Blob
  att: ChatAttachment
}

/**
 * Gets a picked file ready to send: checks the size, re-encodes big pictures
 * (max 2000 px JPEG — quick to send, metadata gone) and notes picture sizes.
 * `path` is where it will live: <company>/<conversation>/<message>/<n>-<name>.
 */
export const prepareFile = async (file: File, folder: string, index: number): Promise<PreparedFile> => {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is bigger than 25 MB.`)
  let blob: Blob = file
  let name = safeName(file.name)
  let type = file.type || 'application/octet-stream'
  let w: number | undefined
  let h: number | undefined
  if (isPicture(type)) {
    const img = await loadImage(file)
    if (img) {
      w = img.naturalWidth
      h = img.naturalHeight
      const big = file.size > PICTURE_RESIZE_OVER_BYTES || Math.max(w, h) > PICTURE_MAX_EDGE
      if (big && type !== 'image/gif') {
        const scale = Math.min(1, PICTURE_MAX_EDGE / Math.max(w, h))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(w * scale)
        canvas.height = Math.round(h * scale)
        const c = canvas.getContext('2d')
        if (c) {
          c.drawImage(img, 0, 0, canvas.width, canvas.height)
          const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.86))
          if (out) {
            blob = out
            type = 'image/jpeg'
            name = name.replace(/\.[^.]+$/, '') + '.jpg'
            w = canvas.width
            h = canvas.height
          }
        }
      }
    }
  }
  return { blob, att: { path: `${folder}/${index}-${name}`, name, size: blob.size, type, w, h } }
}
