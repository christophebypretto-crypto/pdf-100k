import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import { ocrCanvas, OcrWord } from './ocr'
import { TextAnnotation, newId } from './annotations'

export interface SearchableProgress {
  page: number
  totalPages: number
  pct: number // 0-100 sur la page courante
}

// Groupe les mots OCR par ligne (memes Y, X croissants)
function groupWordsIntoLines(words: OcrWord[]): { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[] {
  if (words.length === 0) return []
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  const lines: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[] = []
  let cur = {
    text: sorted[0].text,
    bbox: { ...sorted[0].bbox }
  }
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i]
    const lineH = cur.bbox.y1 - cur.bbox.y0
    // Meme ligne si la baseline est dans la meme bande verticale
    if (Math.abs(w.bbox.y0 - cur.bbox.y0) < lineH * 0.6) {
      cur.text += ' ' + w.text
      cur.bbox.x1 = Math.max(cur.bbox.x1, w.bbox.x1)
      cur.bbox.y1 = Math.max(cur.bbox.y1, w.bbox.y1)
    } else {
      lines.push(cur)
      cur = { text: w.text, bbox: { ...w.bbox } }
    }
  }
  lines.push(cur)
  return lines
}

/**
 * OCR chaque page d'un PDF et renvoie un tableau d'annotations texte editables,
 * une par ligne detectee, positionnees aux bonnes coords normalisees.
 */
export async function ocrToEditableAnnotations(
  data: ArrayBuffer,
  onProgress?: (p: SearchableProgress) => void
): Promise<TextAnnotation[]> {
  const copy = data.slice(0)
  const doc = await pdfjsLib.getDocument({ data: copy }).promise
  const annotations: TextAnnotation[] = []

  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, viewport }).promise

    const ocr = await ocrCanvas(canvas, 'fra+eng', (pct) => {
      onProgress?.({ page: i + 1, totalPages: doc.numPages, pct })
    })

    const lines = groupWordsIntoLines(ocr.words.filter((w) => w.confidence >= 30))
    for (const ln of lines) {
      if (!ln.text.trim()) continue
      const x = ln.bbox.x0 / canvas.width
      const y = ln.bbox.y0 / canvas.height
      const heightNorm = (ln.bbox.y1 - ln.bbox.y0) / canvas.height
      // taille = hauteur normalisee × hauteur page en points (approx en utilisant viewport ratio)
      const fontSize = Math.max(6, Math.min(48, heightNorm * (viewport.height / 2)))
      annotations.push({
        id: newId(),
        kind: 'text',
        pageIndex: i,
        x,
        y,
        text: ln.text,
        size: fontSize,
        color: '#000000'
      })
    }

    onProgress?.({ page: i + 1, totalPages: doc.numPages, pct: 100 })
  }

  await doc.destroy()
  return annotations
}

/**
 * OCR sur une zone (rect normalise [0,1]) d'une page specifique.
 * Renvoie le texte detecte dans cette zone.
 */
export async function ocrOnZone(
  data: ArrayBuffer,
  pageIndex: number,
  rect: { x: number; y: number; w: number; h: number }
): Promise<string> {
  const copy = data.slice(0)
  const doc = await pdfjsLib.getDocument({ data: copy }).promise
  try {
    const page = await doc.getPage(pageIndex + 1)
    const viewport = page.getViewport({ scale: 2 })
    const fullCanvas = document.createElement('canvas')
    fullCanvas.width = viewport.width
    fullCanvas.height = viewport.height
    await page.render({
      canvasContext: fullCanvas.getContext('2d')!,
      viewport
    }).promise

    // Crop a la zone
    const cropX = Math.round(rect.x * fullCanvas.width)
    const cropY = Math.round(rect.y * fullCanvas.height)
    const cropW = Math.round(rect.w * fullCanvas.width)
    const cropH = Math.round(rect.h * fullCanvas.height)
    if (cropW < 20 || cropH < 10) return ''
    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = cropW
    cropCanvas.height = cropH
    cropCanvas
      .getContext('2d')!
      .drawImage(fullCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)
    const ocr = await ocrCanvas(cropCanvas, 'fra+eng')
    return ocr.text
  } finally {
    await doc.destroy()
  }
}

/**
 * Rend chaque page d'un PDF "recherchable" en superposant un calque texte invisible
 * aligné sur les mots detectes par OCR. Le visuel ne change pas.
 */
export async function makeSearchablePdf(
  data: ArrayBuffer,
  onProgress?: (p: SearchableProgress) => void,
  pageIndices?: number[]
): Promise<ArrayBuffer> {
  const copy = data.slice(0)
  const pdfjsDoc = await pdfjsLib.getDocument({ data: copy }).promise
  const out = await PDFDocument.load(data, { ignoreEncryption: true })
  const font = await out.embedFont(StandardFonts.Helvetica)
  const pages = out.getPages()
  const indices = pageIndices ?? pages.map((_, i) => i)

  for (let k = 0; k < indices.length; k++) {
    const idx = indices[k]
    const pdfjsPage = await pdfjsDoc.getPage(idx + 1)
    const viewport = pdfjsPage.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')!
    await pdfjsPage.render({ canvasContext: ctx, viewport }).promise

    const ocr = await ocrCanvas(canvas, 'fra+eng', (pct) => {
      onProgress?.({ page: idx + 1, totalPages: pages.length, pct })
    })

    const page = pages[idx]
    // Le canvas OCR est rendu par pdfjs, donc dans le repere de la CropBox :
    // c'est sur elle qu'il faut recaler le texte invisible, origine comprise.
    const boite = page.getCropBox()
    const pw = boite.width
    const ph = boite.height
    const sx = pw / canvas.width
    const sy = ph / canvas.height

    for (const w of ocr.words) {
      if (!w.text.trim() || w.confidence < 30) continue
      const x = boite.x + w.bbox.x0 * sx
      const yTopPdf = boite.y + ph - w.bbox.y0 * sy
      const yBotPdf = boite.y + ph - w.bbox.y1 * sy
      const fontSize = Math.max(1, yTopPdf - yBotPdf)
      page.drawText(w.text, {
        x,
        y: yBotPdf,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
        opacity: 0.001 // pratiquement invisible mais selectable/recherchable
      })
    }

    onProgress?.({ page: idx + 1, totalPages: pages.length, pct: 100 })
  }

  await pdfjsDoc.destroy()
  const bytes = await out.save()
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  return buf
}
