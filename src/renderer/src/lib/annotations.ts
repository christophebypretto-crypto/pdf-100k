import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib'

// Coordonnees normalisees [0,1] en espace page (origine top-left, comme l'ecran)
// La conversion vers PDF (origine bottom-left) se fait au moment du save.

export type Annotation =
  | HighlightAnnotation
  | PenAnnotation
  | TextAnnotation
  | ImageAnnotation
  | EraserAnnotation

export interface BaseAnnotation {
  id: string
  pageIndex: number
}

export interface HighlightAnnotation extends BaseAnnotation {
  kind: 'highlight'
  rect: { x: number; y: number; w: number; h: number } // normalise [0,1]
  color: string // hex
  opacity?: number // 0..1, defaut 0.35
  rotation?: number // degres convention PDF (counterclockwise positive). Pivot = centre du rect.
}

export interface PenAnnotation extends BaseAnnotation {
  kind: 'pen'
  points: { x: number; y: number }[] // normalise [0,1]
  color: string
  width: number // pixels logiques @ scale 1
}

export interface TextAnnotation extends BaseAnnotation {
  kind: 'text'
  x: number // top-left normalise [0,1] (origin top-left). Quand rotation est defini : (x,y) = baseline-left du texte.
  y: number
  text: string
  size: number // pt en PDF
  color: string
  // Style optionnel — utilise quand on modifie du texte existant
  fontFamily?: 'helvetica' | 'times' | 'courier'
  bold?: boolean
  italic?: boolean
  // Rotation en degres (convention PDF : counterclockwise positive)
  // Quand defini et non nul, (x, y) represente le baseline-left du texte (pas le top-left de bbox).
  rotation?: number
  // --- Fond opaque integre (outil "Modifier") ---
  // Quand defini, un rectangle plein de couleur `background` est peint DERRIERE le texte
  // (dans le meme noeud DOM en apercu → plus de probleme de z-index ; dessine avant le
  // texte au save → le texte passe par-dessus). Remplace l'ancien couple eraser+texte.
  background?: string // hex opaque
  // Geometrie du fond, MEME convention de coords/rotation que (x,y) :
  // - rotation defini → backgroundRect.x/y = pivot baseline-left, le rect monte vers le haut
  // - sinon → backgroundRect.x/y = top-left
  backgroundRect?: { x: number; y: number; w: number; h: number }
}

export interface ImageAnnotation extends BaseAnnotation {
  kind: 'image'
  x: number
  y: number
  w: number
  h: number
  dataUrl: string // PNG dataURL
  rotation?: number // degres convention PDF (counterclockwise positive). Pivot = centre de l'image.
}

export interface EraserAnnotation extends BaseAnnotation {
  kind: 'eraser'
  rect: { x: number; y: number; w: number; h: number } // normalise [0,1]
  color?: string // hex, defaut blanc #FFFFFF
  // Rotation en degres (convention PDF : counterclockwise positive).
  // Quand defini et non nul, rect.x/rect.y = point pivot (= baseline-left du texte d'origine) ;
  // le rectangle s'etend vers la droite (rect.w) et vers le HAUT en PDF (rect.h) et tourne autour du pivot.
  rotation?: number
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 11)
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '')
  return {
    r: parseInt(m.slice(0, 2), 16) / 255,
    g: parseInt(m.slice(2, 4), 16) / 255,
    b: parseInt(m.slice(4, 6), 16) / 255
  }
}

// Convertit y "top-left normalise" → coord PDF "bottom-left en points"

/**
 * Pour rotation autour du CENTRE : calcule le bottom-left a passer a pdf-lib
 * pour qu'apres rotation autour de (x_new, y_new), le centre soit au meme endroit.
 */
function bottomLeftForCenterRotation(
  cx: number,
  cy: number,
  w: number,
  h: number,
  rotDeg: number
): { x: number; y: number } {
  const rad = (rotDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // Centre = (x_new + (w/2)cos - (h/2)sin, y_new + (w/2)sin + (h/2)cos)
  // donc : x_new = cx - (w/2)cos + (h/2)sin
  //        y_new = cy - (w/2)sin - (h/2)cos
  return {
    x: cx - (w / 2) * cos + (h / 2) * sin,
    y: cy - (w / 2) * sin - (h / 2) * cos
  }
}

function pickStandardFontEnum(
  family?: 'helvetica' | 'times' | 'courier',
  bold?: boolean,
  italic?: boolean
): StandardFonts {
  const f = family || 'helvetica'
  if (f === 'times') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic
    if (bold) return StandardFonts.TimesRomanBold
    if (italic) return StandardFonts.TimesRomanItalic
    return StandardFonts.TimesRoman
  }
  if (f === 'courier') {
    if (bold && italic) return StandardFonts.CourierBoldOblique
    if (bold) return StandardFonts.CourierBold
    if (italic) return StandardFonts.CourierOblique
    return StandardFonts.Courier
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique
  if (bold) return StandardFonts.HelveticaBold
  if (italic) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

/** Applique toutes les annotations dans le PDF et renvoie un nouvel ArrayBuffer */
export async function applyAnnotationsToPdf(
  data: ArrayBuffer,
  annotations: Annotation[]
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(data, { ignoreEncryption: true })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  // Cache pour eviter de re-embedder le meme StandardFont plusieurs fois
  const fontCache = new Map<StandardFonts, Awaited<ReturnType<typeof doc.embedFont>>>()
  fontCache.set(StandardFonts.Helvetica, font)
  const getFont = async (
    family?: 'helvetica' | 'times' | 'courier',
    bold?: boolean,
    italic?: boolean
  ) => {
    const e = pickStandardFontEnum(family, bold, italic)
    if (fontCache.has(e)) return fontCache.get(e)!
    const f = await doc.embedFont(e)
    fontCache.set(e, f)
    return f
  }
  const pages = doc.getPages()

  // Cache des images embed (pour ne pas re-embed la meme signature N fois)
  const imageCache = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>()

  for (const a of annotations) {
    const page = pages[a.pageIndex]
    if (!page) continue
    // Une page ne commence pas forcement en (0,0) : sa boite peut etre decalee.
    // Vu en vrai sur une attestation signee YouSign : MediaBox
    // [0, 7.83, 595.5, 850.08]. Sans tenir compte de l'origine, toutes les
    // annotations se posent decalees d'autant.
    //
    // Origine ET dimensions viennent de la MEME boite, la CropBox : c'est celle
    // que pdfjs utilise pour afficher la page, donc celle dans laquelle
    // l'utilisateur a clique. `page.getSize()` ne donnerait que les dimensions
    // de la MediaBox en jetant son origine — melanger les deux rouvrirait le
    // meme bug des que les deux boites different.
    const boite = page.getCropBox()
    const pw = boite.width
    const ph = boite.height
    const ox = boite.x
    const oy = boite.y
    /** x normalise -> x absolu dans l'espace PDF */
    const px = (xNorm: number): number => ox + xNorm * pw
    /** y normalise (origine en haut) -> y absolu dans l'espace PDF */
    const toPdfY = (yNorm: number, pageHeight: number): number =>
      oy + pageHeight - yNorm * pageHeight
    const rotation = page.getRotation().angle % 360

    if (a.kind === 'highlight') {
      const c = hexToRgb(a.color)
      const wPdf = a.rect.w * pw
      const hPdf = a.rect.h * ph
      const rotDeg = a.rotation || 0
      if (Math.abs(rotDeg) > 0.001) {
        // Rotation autour du centre
        const cx = px(a.rect.x + a.rect.w / 2)
        const cy = toPdfY(a.rect.y + a.rect.h / 2, ph)
        const bl = bottomLeftForCenterRotation(cx, cy, wPdf, hPdf, rotDeg)
        page.drawRectangle({
          x: bl.x,
          y: bl.y,
          width: wPdf,
          height: hPdf,
          color: rgb(c.r, c.g, c.b),
          opacity: a.opacity ?? 0.35,
          rotate: degrees(rotDeg)
        })
      } else {
        page.drawRectangle({
          x: px(a.rect.x),
          y: toPdfY(a.rect.y + a.rect.h, ph),
          width: wPdf,
          height: hPdf,
          color: rgb(c.r, c.g, c.b),
          opacity: a.opacity ?? 0.35
        })
      }
    } else if (a.kind === 'pen') {
      const c = hexToRgb(a.color)
      const pts = a.points
      for (let i = 1; i < pts.length; i++) {
        const p1 = pts[i - 1]
        const p2 = pts[i]
        page.drawLine({
          start: { x: px(p1.x), y: toPdfY(p1.y, ph) },
          end: { x: px(p2.x), y: toPdfY(p2.y, ph) },
          thickness: a.width,
          color: rgb(c.r, c.g, c.b),
          opacity: 0.9
        })
      }
    } else if (a.kind === 'text') {
      const c = hexToRgb(a.color)
      const textFont = await getFont(a.fontFamily, a.bold, a.italic)

      // Fond opaque integre (outil "Modifier") : dessine AVANT le texte, donc le
      // texte passe par-dessus. Meme convention de coords que (x,y).
      if (a.background && a.backgroundRect) {
        const bg = hexToRgb(a.background)
        const br = a.backgroundRect
        if (a.rotation !== undefined && Math.abs(a.rotation) > 0.001) {
          // pivot = baseline-left (br.x, br.y), le rect monte vers le haut et tourne
          page.drawRectangle({
            x: px(br.x),
            y: toPdfY(br.y, ph),
            width: br.w * pw,
            height: br.h * ph,
            color: rgb(bg.r, bg.g, bg.b),
            opacity: 1,
            rotate: degrees(a.rotation)
          })
        } else {
          // br.x/br.y = top-left
          page.drawRectangle({
            x: px(br.x),
            y: toPdfY(br.y + br.h, ph),
            width: br.w * pw,
            height: br.h * ph,
            color: rgb(bg.r, bg.g, bg.b),
            opacity: 1
          })
        }
      }

      if (a.rotation !== undefined) {
        // Mode baseline-left activé dès que rotation est defini (peut être 0)
        // Rotated: (x, y) = baseline-left ; multi-lignes peu probable mais on supporte
        const lines = a.text.split('\n')
        const xBase = px(a.x)
        const yBase = toPdfY(a.y, ph)
        lines.forEach((ln, i) => {
          // Decale chaque ligne sur l'axe perpendiculaire a la rotation
          const rad = (a.rotation! * Math.PI) / 180
          const dx = -i * a.size * 1.25 * Math.sin(rad)
          const dy = -i * a.size * 1.25 * Math.cos(rad)
          page.drawText(ln, {
            x: xBase + dx,
            y: yBase + dy,
            size: a.size,
            font: textFont,
            color: rgb(c.r, c.g, c.b),
            rotate: degrees(a.rotation!)
          })
        })
      } else {
        const lines = a.text.split('\n')
        const lineHeight = a.size * 1.25
        lines.forEach((ln, i) => {
          const x = px(a.x)
          // y top-left de la 1ere ligne → on baisse de fontHeight pour la baseline
          const y = toPdfY(a.y, ph) - a.size - i * lineHeight
          page.drawText(ln, {
            x,
            y,
            size: a.size,
            font: textFont,
            color: rgb(c.r, c.g, c.b)
          })
        })
      }
      // Ignore rotation for now (rotation parameter unused)
      void rotation
    } else if (a.kind === 'eraser') {
      const c = hexToRgb(a.color || '#FFFFFF')
      if (a.rotation !== undefined && Math.abs(a.rotation) > 0.001) {
        // rect.x/y = pivot (baseline-left), rect.w/h = dimensions ; rect "monte" depuis le pivot
        const x = px(a.rect.x)
        const y = toPdfY(a.rect.y, ph) // pivot Y en PDF
        const w = a.rect.w * pw
        const h = a.rect.h * ph
        page.drawRectangle({
          x,
          y,
          width: w,
          height: h,
          color: rgb(c.r, c.g, c.b),
          opacity: 1,
          rotate: degrees(a.rotation)
        })
      } else {
        const x = px(a.rect.x)
        const y = toPdfY(a.rect.y + a.rect.h, ph)
        const w = a.rect.w * pw
        const h = a.rect.h * ph
        page.drawRectangle({
          x,
          y,
          width: w,
          height: h,
          color: rgb(c.r, c.g, c.b),
          opacity: 1
        })
      }
    } else if (a.kind === 'image') {
      let img = imageCache.get(a.dataUrl)
      if (!img) {
        const b64 = a.dataUrl.split(',')[1]
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        // Le format compte : embedPng sur un JPEG echoue. Les signatures sont
        // toujours en PNG (dessinees sur un canvas), mais l'outil « Image »
        // accepte aussi des photos JPEG — qu'on garde telles quelles, les
        // reconvertir en PNG ferait exploser le poids du PDF.
        const estJpeg = a.dataUrl.startsWith('data:image/jpeg') || a.dataUrl.startsWith('data:image/jpg')
        img = estJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
        imageCache.set(a.dataUrl, img)
      }
      const wPdf = a.w * pw
      const hPdf = a.h * ph
      const rotDeg = a.rotation || 0
      if (Math.abs(rotDeg) > 0.001) {
        const cx = px(a.x + a.w / 2)
        const cy = toPdfY(a.y + a.h / 2, ph)
        const bl = bottomLeftForCenterRotation(cx, cy, wPdf, hPdf, rotDeg)
        page.drawImage(img, {
          x: bl.x,
          y: bl.y,
          width: wPdf,
          height: hPdf,
          rotate: degrees(rotDeg)
        })
      } else {
        page.drawImage(img, {
          x: px(a.x),
          y: toPdfY(a.y + a.h, ph),
          width: wPdf,
          height: hPdf
        })
      }
    }
  }

  const bytes = await doc.save()
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}
