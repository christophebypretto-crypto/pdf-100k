import * as pdfjsLib from 'pdfjs-dist'

export interface TextHit {
  text: string
  // AABB (axis-aligned bounding box) en coords normalisees [0,1] (origin top-left de la page)
  // Utilise pour positionner l'editeur horizontal au-dessus du texte
  x: number
  y: number
  width: number
  height: number
  // Baseline-left du texte original en coords normalisees [0,1] (origin top-left)
  // Utilise pour creer les annotations (eraser + texte) avec rotation
  baselineX: number
  baselineY: number
  // Dimensions reelles du texte (pas l'AABB) en coords normalisees
  textWidth: number
  textHeight: number
  fontSize: number // taille en points PDF
  fontFamily: 'helvetica' | 'times' | 'courier'
  bold: boolean
  italic: boolean
  // Rotation en degres (convention PDF : counterclockwise positive). 0 = texte horizontal
  rotation: number
  // Matrice de rendu brute renvoyee par pdfjs, en unites PDF. Sert a retrouver
  // l'operateur qui dessine ce texte pour le supprimer pour de vrai
  // (cf. lib/contentTextRemoval).
  rawTransform: number[]
}

function classifyFont(name: string): {
  family: 'helvetica' | 'times' | 'courier'
  bold: boolean
  italic: boolean
} {
  // Retire le prefixe de subset PDF (ex "ABCDEF+Calibri") puis normalise.
  const n = name.toLowerCase().replace(/^[a-z]{6}\+/i, '')
  // Les graisses "light/thin/medium" ne doivent PAS etre marquees bold.
  const isLight = /(light|thin|ultra|extralight|hairline|medium)/.test(n)
  const bold = !isLight && /(bold|heavy|black|semibold|demibold|demi)/.test(n)
  const italic = /(italic|oblique)/.test(n)
  let family: 'helvetica' | 'times' | 'courier' = 'helvetica'
  if (/(courier|consolas|menlo|monaco|mono)/.test(n)) {
    family = 'courier'
  } else if (
    /(times|roman|georgia|garamond|minion|cambria|palatino|book antiqua|serif)/.test(n) &&
    !/sans/.test(n)
  ) {
    family = 'times'
  }
  return { family, bold, italic }
}

/**
 * Trouve le texte sous le point clique sur une page.
 * Coords du clic normalisees [0,1] (top-left).
 * Renvoie null si aucun texte trouve a cet endroit.
 */
export async function findTextAtPoint(
  pdfjsDoc: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
  clickX: number,
  clickY: number
): Promise<TextHit | null> {
  const page = await pdfjsDoc.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  const pageW = viewport.width
  const pageH = viewport.height
  // Click en coords PDF (origine bottom-left)
  const px = clickX * pageW
  const py = pageH - clickY * pageH

  const styles = tc.styles as Record<string, { fontFamily?: string }>

  for (const item of tc.items) {
    if (!('str' in item) || !item.str) continue
    const t = item.transform as number[]
    const a = t[0]
    const b = t[1]
    const c = t[2]
    const d = t[3]
    const e = t[4]
    const f = t[5]
    const w = item.width || 0
    const h = item.height || 0
    if (w <= 0 || h <= 0) continue

    const scaleX = Math.hypot(a, b) || 1
    const scaleY = Math.hypot(c, d) || scaleX

    // Project click into text-local coords (handles any rotation)
    const dx = px - e
    const dy = py - f
    const projX = (dx * a + dy * b) / scaleX
    const projY = (dx * c + dy * d) / scaleY
    if (projX < 0 || projX > w) continue
    if (projY < 0 || projY > h) continue

    // Hit !
    const rotationRad = Math.atan2(b, a)
    const rotationDeg = (rotationRad * 180) / Math.PI

    // 4 corners du texte rotated en coords PDF (bottom-left origin)
    const ux = a / scaleX
    const uy = b / scaleX // direction unitaire de l'axe X du texte
    const vx = c / scaleY
    const vy = d / scaleY // direction unitaire de l'axe Y du texte
    const corners = [
      { x: e, y: f }, // baseline-left
      { x: e + w * ux, y: f + w * uy }, // baseline-right
      { x: e + h * vx, y: f + h * vy }, // top-left
      { x: e + w * ux + h * vx, y: f + w * uy + h * vy } // top-right
    ]
    const minX = Math.min(...corners.map((p) => p.x))
    const maxX = Math.max(...corners.map((p) => p.x))
    const minY = Math.min(...corners.map((p) => p.y))
    const maxY = Math.max(...corners.map((p) => p.y))

    const fontSize = scaleX
    const fontName = item.fontName || ''
    const styleName = styles[fontName]?.fontFamily || fontName
    const cls = classifyFont(styleName)

    return {
      text: item.str,
      x: minX / pageW,
      y: (pageH - maxY) / pageH,
      width: (maxX - minX) / pageW,
      height: (maxY - minY) / pageH,
      baselineX: e / pageW,
      baselineY: (pageH - f) / pageH,
      textWidth: w / pageW,
      textHeight: h / pageH,
      fontSize,
      fontFamily: cls.family,
      bold: cls.bold,
      italic: cls.italic,
      rotation: rotationDeg,
      rawTransform: [a, b, c, d, e, f]
    }
  }
  return null
}

/** Mappe la famille interne vers une stack CSS pour le rendu navigateur */
export function fontFamilyToCss(family: 'helvetica' | 'times' | 'courier'): string {
  if (family === 'times') return '"Times New Roman", Times, serif'
  if (family === 'courier') return '"Courier New", Courier, monospace'
  return 'Arial, Helvetica, sans-serif'
}

/**
 * Renvoie tous les items texte d'une page (utile pour afficher les overlays
 * cliquables dans le mode Modifier).
 */
export async function getAllTextItems(
  pdfjsDoc: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
  minLength = 2
): Promise<TextHit[]> {
  const page = await pdfjsDoc.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  const pageW = viewport.width
  const pageH = viewport.height
  const styles = tc.styles as Record<string, { fontFamily?: string }>
  const result: TextHit[] = []

  for (const item of tc.items) {
    if (!('str' in item) || !item.str) continue
    if (item.str.trim().length < minLength) continue

    const t = item.transform as number[]
    const a = t[0]
    const b = t[1]
    const c = t[2]
    const d = t[3]
    const e = t[4]
    const f = t[5]
    const w = item.width || 0
    const h = item.height || 0
    if (w <= 0 || h <= 0) continue

    const scaleX = Math.hypot(a, b) || 1
    const scaleY = Math.hypot(c, d) || scaleX
    const ux = a / scaleX
    const uy = b / scaleX
    const vx = c / scaleY
    const vy = d / scaleY

    const corners = [
      { x: e, y: f },
      { x: e + w * ux, y: f + w * uy },
      { x: e + h * vx, y: f + h * vy },
      { x: e + w * ux + h * vx, y: f + w * uy + h * vy }
    ]
    const minX = Math.min(...corners.map((p) => p.x))
    const maxX = Math.max(...corners.map((p) => p.x))
    const minY = Math.min(...corners.map((p) => p.y))
    const maxY = Math.max(...corners.map((p) => p.y))

    const rotationDeg = (Math.atan2(b, a) * 180) / Math.PI
    const fontSize = scaleX
    const fontName = item.fontName || ''
    const styleName = styles[fontName]?.fontFamily || fontName
    const cls = classifyFont(styleName)

    result.push({
      text: item.str,
      x: minX / pageW,
      y: (pageH - maxY) / pageH,
      width: (maxX - minX) / pageW,
      height: (maxY - minY) / pageH,
      baselineX: e / pageW,
      baselineY: (pageH - f) / pageH,
      textWidth: w / pageW,
      textHeight: h / pageH,
      fontSize,
      fontFamily: cls.family,
      bold: cls.bold,
      italic: cls.italic,
      rotation: rotationDeg,
      rawTransform: [a, b, c, d, e, f]
    })
  }
  return result
}
