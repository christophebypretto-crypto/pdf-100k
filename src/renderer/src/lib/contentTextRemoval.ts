import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'

/**
 * SUPPRESSION REELLE de texte dans un PDF.
 *
 * Contrairement au masque (rectangle blanc pose PAR-DESSUS), ce module va
 * chercher l'operateur de dessin du texte DANS le flux de contenu de la page
 * et le retire. Apres passage : le texte n'est plus affiche, plus selectionnable,
 * plus extractible — il n'existe simplement plus dans le fichier.
 *
 * Principe :
 *  1. pdfjs nous donne, pour chaque bout de texte, sa matrice de rendu (position,
 *     taille, rotation) et sa largeur → c'est notre "cible".
 *  2. On tokenise le flux de contenu de la page et on rejoue la machine d'etat
 *     PDF (q/Q, cm, BT/ET, Tm/Td/TD/T*, Tf, Tz…) pour calculer la matrice de
 *     rendu de CHAQUE operateur d'affichage (Tj, TJ, ', ").
 *  3. L'operateur dont la matrice coincide avec la cible est supprime, et
 *     remplace par un deplacement equivalent ([N] TJ) pour que le texte qui
 *     suit dans le meme bloc ne bouge pas d'un pouce.
 *  4. Filet de securite : on re-extrait le texte de la page apres coup. Si on a
 *     emporte autre chose que la cible, on annule la page (l'appelant retombe
 *     alors sur le masque classique).
 */

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** Produit matriciel PDF : m x n */
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5]
  ]
}

// ---------------------------------------------------------------------------
// Tokeniseur de flux de contenu
// ---------------------------------------------------------------------------

const enum C {
  NUL = 0x00,
  TAB = 0x09,
  LF = 0x0a,
  FF = 0x0c,
  CR = 0x0d,
  SP = 0x20,
  PCT = 0x25, // %
  LPAREN = 0x28,
  RPAREN = 0x29,
  LT = 0x3c, // <
  GT = 0x3e, // >
  LBRACKET = 0x5b,
  RBRACKET = 0x5d,
  LBRACE = 0x7b,
  RBRACE = 0x7d,
  SLASH = 0x2f,
  BACKSLASH = 0x5c
}

function isWs(b: number): boolean {
  return b === C.SP || b === C.LF || b === C.CR || b === C.TAB || b === C.FF || b === C.NUL
}

function isDelim(b: number): boolean {
  return (
    b === C.LPAREN ||
    b === C.RPAREN ||
    b === C.LT ||
    b === C.GT ||
    b === C.LBRACKET ||
    b === C.RBRACKET ||
    b === C.LBRACE ||
    b === C.RBRACE ||
    b === C.SLASH ||
    b === C.PCT
  )
}

interface Token {
  /** 'operand' = nombre, nom, chaine, tableau, dictionnaire ; 'op' = operateur */
  kind: 'operand' | 'op'
  start: number
  end: number // exclusif
  text: string // latin1
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i])
  return s
}

/** Avance au-dela d'une chaine litterale ( ... ), parentheses imbriquees + echappements. */
function skipLiteralString(b: Uint8Array, i: number): number {
  // b[i] === '('
  let depth = 0
  while (i < b.length) {
    const c = b[i]
    if (c === C.BACKSLASH) {
      i += 2
      continue
    }
    if (c === C.LPAREN) depth++
    else if (c === C.RPAREN) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return i
}

/** Avance au-dela d'un tableau [ ... ] ou d'un dictionnaire << ... >>, contenu compris. */
function skipComposite(b: Uint8Array, i: number, open: number, close: number): number {
  let depth = 0
  while (i < b.length) {
    const c = b[i]
    if (c === C.LPAREN) {
      i = skipLiteralString(b, i)
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return i
}

/** Avance au-dela d'un dictionnaire << ... >> (les chevrons vont par paires). */
function skipDict(b: Uint8Array, i: number): number {
  let depth = 0
  while (i < b.length) {
    const c = b[i]
    if (c === C.LPAREN) {
      i = skipLiteralString(b, i)
      continue
    }
    if (c === C.LT && b[i + 1] === C.LT) {
      depth++
      i += 2
      continue
    }
    if (c === C.GT && b[i + 1] === C.GT) {
      depth--
      i += 2
      if (depth === 0) return i
      continue
    }
    if (c === C.LT) {
      // chaine hexa a l'interieur du dictionnaire
      while (i < b.length && b[i] !== C.GT) i++
      i++
      continue
    }
    i++
  }
  return i
}

/**
 * Saute une image en ligne : BI <dict> ID <donnees binaires> EI.
 * Les donnees peuvent contenir n'importe quoi, y compris "EI" — on ne coupe que
 * sur un EI isole (precede d'un blanc, suivi d'un blanc/delimiteur/fin).
 */
function skipInlineImage(b: Uint8Array, i: number): number {
  // i pointe juste apres l'operateur BI
  while (i < b.length - 1) {
    if (b[i] === 0x49 /* I */ && b[i + 1] === 0x44 /* D */) {
      const before = i === 0 ? C.SP : b[i - 1]
      const after = b[i + 2]
      if ((isWs(before) || isDelim(before)) && (isWs(after) || isDelim(after))) {
        i += 3 // ID + 1 blanc
        break
      }
    }
    i++
  }
  while (i < b.length - 1) {
    if (b[i] === 0x45 /* E */ && b[i + 1] === 0x49 /* I */) {
      const before = i === 0 ? C.SP : b[i - 1]
      const after = i + 2 < b.length ? b[i + 2] : C.SP
      if (isWs(before) && (isWs(after) || isDelim(after))) return i + 2
    }
    i++
  }
  return b.length
}

function tokenize(b: Uint8Array): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < b.length) {
    const c = b[i]
    if (isWs(c)) {
      i++
      continue
    }
    if (c === C.PCT) {
      while (i < b.length && b[i] !== C.LF && b[i] !== C.CR) i++
      continue
    }
    const start = i
    if (c === C.LPAREN) {
      i = skipLiteralString(b, i)
      out.push({ kind: 'operand', start, end: i, text: latin1(b, start, i) })
      continue
    }
    if (c === C.LT && b[i + 1] === C.LT) {
      i = skipDict(b, i)
      out.push({ kind: 'operand', start, end: i, text: '' })
      continue
    }
    if (c === C.LT) {
      while (i < b.length && b[i] !== C.GT) i++
      i++
      out.push({ kind: 'operand', start, end: i, text: latin1(b, start, i) })
      continue
    }
    if (c === C.LBRACKET) {
      i = skipComposite(b, i, C.LBRACKET, C.RBRACKET)
      out.push({ kind: 'operand', start, end: i, text: latin1(b, start, i) })
      continue
    }
    if (c === C.SLASH) {
      i++
      while (i < b.length && !isWs(b[i]) && !isDelim(b[i])) i++
      out.push({ kind: 'operand', start, end: i, text: latin1(b, start, i) })
      continue
    }
    if (c === C.RBRACKET || c === C.GT || c === C.LBRACE || c === C.RBRACE) {
      i++ // isole → flux malforme, on ignore
      continue
    }
    // Nombre ou operateur
    i++
    while (i < b.length && !isWs(b[i]) && !isDelim(b[i])) i++
    const text = latin1(b, start, i)
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) {
      out.push({ kind: 'operand', start, end: i, text })
      continue
    }
    out.push({ kind: 'op', start, end: i, text })
    if (text === 'BI') {
      i = skipInlineImage(b, i)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Machine d'etat : matrice de rendu de chaque operateur d'affichage de texte
// ---------------------------------------------------------------------------

interface TextState {
  ctm: Matrix
  fontSize: number
  hscale: number // Tz / 100
  leading: number
  rise: number
}

/** Un operateur qui dessine du texte, avec sa matrice de rendu. */
interface ShowOp {
  kind: 'Tj' | 'TJ' | 'quote' | 'dquote'
  /** debut du 1er operande (donc de tout ce qu'il faudra remplacer) */
  start: number
  /** fin de l'operateur (exclusif) */
  end: number
  trm: Matrix
  /** operandes bruts (pour reconstituer aw/ac du " ) */
  operands: string[]
  /**
   * Vrai si un autre affichage suit dans le meme bloc SANS repositionnement :
   * il faut alors compenser l'avancement du curseur pour ne pas le decaler.
   * Faux dans l'immense majorite des cas (le texte suivant est repositionne).
   */
  needsAdvance: boolean
}

function num(s: string | undefined): number {
  const v = parseFloat(s ?? '')
  return Number.isFinite(v) ? v : 0
}

function collectShowOps(bytes: Uint8Array): ShowOp[] {
  const tokens = tokenize(bytes)
  const ops: ShowOp[] = []

  let st: TextState = { ctm: IDENTITY, fontSize: 0, hscale: 1, leading: 0, rise: 0 }
  const stack: TextState[] = []
  let tm: Matrix = IDENTITY
  let tlm: Matrix = IDENTITY

  let operands: Token[] = []
  // dernier affichage rencontre, tant qu'aucun repositionnement n'a eu lieu
  let pending: ShowOp | null = null

  const trm = (): Matrix =>
    mul(mul([st.fontSize * st.hscale, 0, 0, st.fontSize, 0, st.rise], tm), st.ctm)

  for (const t of tokens) {
    if (t.kind === 'operand') {
      operands.push(t)
      continue
    }
    const op = t.text
    const n = (k: number): number => num(operands[operands.length - k]?.text)

    switch (op) {
      case 'q':
        stack.push({ ...st })
        break
      case 'Q': {
        const prev = stack.pop()
        if (prev) st = prev
        break
      }
      case 'cm':
        if (operands.length >= 6) {
          const m = operands.slice(-6).map((o) => num(o.text)) as Matrix
          st.ctm = mul(m, st.ctm)
        }
        break
      case 'BT':
        tm = IDENTITY
        tlm = IDENTITY
        pending = null
        break
      case 'ET':
        pending = null
        break
      case 'Tf':
        st.fontSize = n(1)
        break
      case 'Tz':
        st.hscale = n(1) / 100
        break
      case 'TL':
        st.leading = n(1)
        break
      case 'Ts':
        st.rise = n(1)
        break
      case 'Tm':
        if (operands.length >= 6) {
          tm = operands.slice(-6).map((o) => num(o.text)) as Matrix
          tlm = tm
        }
        pending = null
        break
      case 'Td': {
        tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm)
        tm = tlm
        pending = null
        break
      }
      case 'TD': {
        st.leading = -n(1)
        tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm)
        tm = tlm
        pending = null
        break
      }
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -st.leading], tlm)
        tm = tlm
        pending = null
        break
      case 'Tj':
      case 'TJ': {
        const show: ShowOp = {
          kind: op as 'Tj' | 'TJ',
          start: operands.length ? operands[operands.length - 1].start : t.start,
          end: t.end,
          trm: trm(),
          operands: operands.map((o) => o.text),
          needsAdvance: false
        }
        if (pending) pending.needsAdvance = true
        pending = show
        ops.push(show)
        break
      }
      case "'": {
        // = T* puis Tj
        tlm = mul([1, 0, 0, 1, 0, -st.leading], tlm)
        tm = tlm
        const show: ShowOp = {
          kind: 'quote',
          start: operands.length ? operands[operands.length - 1].start : t.start,
          end: t.end,
          trm: trm(),
          operands: operands.map((o) => o.text),
          needsAdvance: false
        }
        pending = show // le T* de l'operateur suffit au precedent
        ops.push(show)
        break
      }
      case '"': {
        // aw ac string "  = aw Tw, ac Tc, T*, Tj
        tlm = mul([1, 0, 0, 1, 0, -st.leading], tlm)
        tm = tlm
        const three = operands.slice(-3)
        const show: ShowOp = {
          kind: 'dquote',
          start: three.length ? three[0].start : t.start,
          end: t.end,
          trm: trm(),
          operands: three.map((o) => o.text),
          needsAdvance: false
        }
        pending = show
        ops.push(show)
        break
      }
      default:
        break
    }
    operands = []
  }
  return ops
}

// ---------------------------------------------------------------------------
// Suppression
// -------------------------------------------------------------------
export interface TextTarget {
  pageIndex: number
  /** matrice de rendu pdfjs du bout de texte (item.transform) */
  transform: number[]
  /** texte du bout — sert a lever les ambiguites */
  str: string
}

export interface RealRemovalResult {
  bytes: ArrayBuffer
  /** nombre de textes reellement retires du flux de contenu */
  removed: number
  /** cibles non supprimees : introuvables, ou refusees car du texte voisin aurait saute */
  failed: TextTarget[]
}

/** Un bout de texte tel que pdfjs le voit. */
interface PageItem {
  transform: number[]
  width: number
  str: string
}

/**
 * Concatene les flux de contenu d'une page en un seul buffer.
 *
 * Renvoie null si la page est illisible pour nous (flux compresse avec une
 * methode exotique, page sans contenu…) : l'appelant laisse alors la page
 * intacte plutot que d'echouer.
 */
function readPageContent(doc: PDFDocument, pageIndex: number): Uint8Array | null {
  const streams: PDFRawStream[] = []
  let parts: Uint8Array[]
  try {
    const contents = doc.getPage(pageIndex).node.Contents()
    if (!contents) return null
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const s = contents.lookup(i)
        if (s instanceof PDFRawStream) streams.push(s)
      }
    } else if (contents instanceof PDFRawStream) {
      streams.push(contents)
    }
    if (!streams.length) return null
    parts = streams.map((s) => decodePDFRawStream(s).decode())
  } catch {
    return null // flux compresse d'une maniere que pdf-lib ne sait pas lire
  }

  let total = 0
  for (const p of parts) total += p.length + 1
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
    out[off++] = 0x0a // separateur : les flux d'une page se comportent comme concatenes
  }
  return out
}

/** Remplace les flux de contenu d'une page par un flux unique. */
function writePageContent(doc: PDFDocument, pageIndex: number, bytes: Uint8Array): void {
  const page = doc.getPage(pageIndex)
  const ref = doc.context.register(doc.context.flateStream(bytes))
  page.node.set(PDFName.of('Contents'), ref)
}

/** Applique une liste d'editions (plages a remplacer) sur un buffer. */
function applyEdits(
  bytes: Uint8Array,
  edits: { start: number; end: number; replacement: string }[]
): Uint8Array {
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  const chunks: Uint8Array[] = []
  let cursor = 0
  for (const e of sorted) {
    if (e.start < cursor) continue // chevauchement → on ignore
    chunks.push(bytes.subarray(cursor, e.start))
    const buf = new Uint8Array(e.replacement.length)
    for (let i = 0; i < e.replacement.length; i++) buf[i] = e.replacement.charCodeAt(i) & 0xff
    chunks.push(buf)
    cursor = e.end
  }
  chunks.push(bytes.subarray(cursor))
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** L'operateur demarre-t-il exactement la ou pdfjs place ce bout de texte ? */
function sameOrigin(trm: number[], target: number[]): boolean {
  if (Math.hypot(trm[4] - target[4], trm[5] - target[5]) > 0.75) return false
  const scale = Math.max(1, Math.hypot(target[0], target[1]))
  for (let i = 0; i < 4; i++) {
    if (Math.abs(trm[i] - target[i]) > 0.02 * scale) return false
  }
  return true
}

/**
 * Un bloc de texte indivisible : les operateurs d'affichage et les bouts de
 * texte pdfjs qui se recouvrent. On garde ou on retire l'ensemble.
 *
 * Les deux sens existent dans la nature :
 *  - un operateur qui dessine plusieurs bouts (filigrane en diagonale) ;
 *  - un mot dessine glyphe par glyphe, donc un bout pour des dizaines
 *    d'operateurs (PDF produits par Chrome, dont ceux de Finspot).
 */
interface OpGroup {
  ops: ShowOp[]
  items: PageItem[]
  /** texte reconstitue par pdfjs (peut etre incomplet sur certains PDF) */
  text: string
  /** texte lu directement dans les operateurs, quand la police le permet */
  rawText: string
}

/** Decode une chaine litterale PDF ( ... ), echappements compris. */
function decodePdfLiteral(s: string): string {
  let out = ''
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = s[++i]
    if (n === 'n') out += '\n'
    else if (n === 'r') out += '\r'
    else if (n === 't') out += '\t'
    else if (n === 'b') out += '\b'
    else if (n === 'f') out += '\f'
    else if (n >= '0' && n <= '7') {
      let oct = n
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i]
      out += String.fromCharCode(parseInt(oct, 8))
    } else if (n !== '\n' && n !== '\r') out += n
  }
  return out
}

/** Decode une chaine hexadecimale PDF < ... >. */
function decodePdfHex(s: string): string {
  const hex = s.slice(1, -1).replace(/[^0-9A-Fa-f]/g, '')
  let out = ''
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  }
  return out
}

/**
 * Texte lisible directement dans les operandes de l'operateur.
 *
 * Marche pour les polices a encodage simple — le cas de la quasi-totalite des
 * filigranes (BROUILLON, DRAFT, COPIE…). Avec une police CID les octets ne
 * veulent rien dire en clair : on renvoie alors une chaine vide et on s'en
 * remet a ce que pdfjs a lu.
 */
function readableOperandText(op: ShowOp): string {
  let raw = ''
  const literal = /\((?:\\.|[^\\)])*\)/g
  for (const o of op.operands) {
    if (o.startsWith('(')) raw += decodePdfLiteral(o)
    else if (o.startsWith('[')) {
      let m: RegExpExecArray | null
      literal.lastIndex = 0
      while ((m = literal.exec(o)) !== null) raw += decodePdfLiteral(m[0])
    } else if (o.startsWith('<') && !o.startsWith('<<')) raw += decodePdfHex(o)
  }
  return /^[\x20-\x7e\xa0-\xff]*$/.test(raw) ? raw : ''
}

/** Position d'un bout de texte par rapport a un operateur, le long de sa ligne. */
function rayPosition(op: ShowOp, item: PageItem): number | null {
  const trm = op.trm
  const t = item.transform
  const scale = Math.hypot(trm[0], trm[1])
  if (scale < 1e-6) return null
  // meme orientation et meme taille ?
  const ref = Math.max(1, scale)
  for (let i = 0; i < 4; i++) {
    if (Math.abs(trm[i] - t[i]) > 0.02 * ref) return null
  }
  const dirX = trm[0] / scale
  const dirY = trm[1] / scale
  const dx = t[4] - trm[4]
  const dy = t[5] - trm[5]
  // le bout doit etre sur la meme ligne de base
  if (Math.abs(-dx * dirY + dy * dirX) > 0.5) return null
  return dx * dirX + dy * dirY
}

/**
 * Regroupe operateurs et bouts de texte qui se recouvrent.
 *
 * Deux liens sont poses, puis fusionnes de proche en proche :
 *  (a) chaque bout de texte appartient au dernier operateur qui commence avant
 *      lui sur sa ligne de base — c'est le cas du filigrane, dont pdfjs ne
 *      restitue qu'un fragment ;
 *  (b) chaque operateur dont l'origine tombe DANS l'etendue d'un bout appartient
 *      a ce bout — c'est le cas du texte dessine glyphe par glyphe.
 *
 * Les deux listes sortent dans l'ordre du flux, ce qui permet d'avancer en
 * parallele au lieu de tout croiser avec tout.
 */
function buildGroups(items: PageItem[], ops: ShowOp[]): OpGroup[] {
  // union-find sur [0..ops.length-1] pour les operateurs
  // et [ops.length..ops.length+items.length-1] pour les bouts de texte
  const parent = new Array<number>(ops.length + items.length)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const next = parent[x]
      parent[x] = r
      x = next
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  let cur = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    // Les bouts blancs sont ignores : pdfjs leur donne parfois une largeur
    // enorme (l'espace entre deux colonnes d'un tableau), ce qui ferait
    // fusionner a tort deux blocs de texte voisins.
    if (!item.str.trim()) continue
    const span = item.width || 0

    // (a) quel operateur dessine le debut de ce bout de texte ?
    // Le cas normal : un operateur demarre exactement dessus. Sinon (filigrane
    // tronque par pdfjs) on prend le dernier operateur qui commence avant lui.
    let owner = -1
    let fallback = -1
    for (let k = Math.max(0, cur - 4); k < ops.length; k++) {
      const proj = rayPosition(ops[k], item)
      if (proj === null) continue // autre ligne, autre taille, autre angle
      if (proj > 0.5) {
        fallback = k // commence avant le bout
        continue
      }
      if (proj >= -0.5) owner = k // meme origine
      break // au-dela, on a depasse le debut du bout
    }
    if (owner < 0) owner = fallback
    if (owner < 0) continue // bout non rattache : on n'y touchera pas

    union(owner, ops.length + i)
    cur = owner

    // (b) les operateurs qui tombent DANS l'etendue du bout lui appartiennent
    // aussi : c'est le cas du texte dessine glyphe par glyphe.
    for (let k = owner + 1; k < ops.length; k++) {
      const proj = rayPosition(ops[k], item)
      if (proj === null) continue
      if (proj <= 0.5 && proj > -span + 0.5) union(k, ops.length + i)
      else if (proj <= -span + 0.5) break
    }
  }

  const buckets = new Map<number, { ops: number[]; items: number[] }>()
  const bucket = (root: number): { ops: number[]; items: number[] } => {
    const b = buckets.get(root)
    if (b) return b
    const fresh = { ops: [] as number[], items: [] as number[] }
    buckets.set(root, fresh)
    return fresh
  }
  for (let k = 0; k < ops.length; k++) bucket(find(k)).ops.push(k)
  for (let i = 0; i < items.length; i++) bucket(find(ops.length + i)).items.push(i)

  const groups: OpGroup[] = []
  for (const b of buckets.values()) {
    if (!b.ops.length || !b.items.length) continue // rien a relier
    const groupOps = b.ops.map((k) => ops[k])
    groups.push({
      ops: groupOps,
      items: b.items.map((i) => items[i]),
      text: b.items.map((i) => items[i].str).join(''),
      rawText: groupOps.map((o) => readableOperandText(o)).join('')
    })
  }
  return groups
}

/**
 * Avancement du curseur produit par un operateur, en unites page : du debut de
 * l'operateur jusqu'au bout du dernier morceau qu'il dessine.
 */
function advanceOf(op: ShowOp, items: PageItem[]): number {
  const trm = op.trm
  const scale = Math.hypot(trm[0], trm[1])
  if (scale < 1e-6) return 0
  const dirX = trm[0] / scale
  const dirY = trm[1] / scale
  let max = 0
  for (const it of items) {
    const proj =
      (it.transform[4] - trm[4]) * dirX + (it.transform[5] - trm[5]) * dirY + (it.width || 0)
    if (proj > max) max = proj
  }
  return max
}

/**
 * Remplacement d'un operateur d'affichage : on retire le dessin mais on conserve
 * l'avancement exact du curseur, pour que le texte suivant du meme bloc ne bouge pas.
 *
 * Un element numerique N dans un TJ deplace de -N/1000 x Tfs x Th, d'ou
 * N = -1000 x avancement_page / echelle_de_la_matrice.
 */
function replacementFor(op: ShowOp, advancePage: number): string {
  const fontScale = Math.hypot(op.trm[0], op.trm[1])
  const advance = fontScale > 1e-6 ? (-1000 * advancePage) / fontScale : 0
  // Le texte suivant est presque toujours repositionne (Tm/Td/T*) : dans ce cas
  // compenser ne servirait a rien et risquerait d'introduire un decalage.
  const shift = op.needsAdvance && Math.abs(advance) > 1e-6 ? `[${advance.toFixed(3)}] TJ` : ''

  if (op.kind === 'quote') return `T* ${shift}`.trim()
  if (op.kind === 'dquote') {
    const aw = op.operands[0] ?? '0'
    const ac = op.operands[1] ?? '0'
    return `${aw} Tw ${ac} Tc T* ${shift}`.trim()
  }
  return shift
}

/**
 * Editions a appliquer pour faire disparaitre un bloc de texte : tous ses
 * operateurs d'affichage sautent.
 *
 * L'avancement du curseur n'a besoin d'etre compense que sur le dernier
 * operateur du bloc, et seulement si ce qui suit n'est pas repositionne.
 */
function editsForGroup(group: OpGroup): { start: number; end: number; replacement: string }[] {
  const ordered = [...group.ops].sort((a, b) => a.start - b.start)
  return ordered.map((op, i) => ({
    start: op.start,
    end: op.end,
    replacement: replacementFor(
      op,
      i === ordered.length - 1 ? advanceOf(op, group.items) : 0
    )
  }))
}

/** Tous les bouts de texte du document, page par page, dans l'ordre du flux. */
async function extractPageItems(data: ArrayBuffer): Promise<PageItem[][]> {
  const doc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise
  const out: PageItem[][] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    const list: PageItem[] = []
    for (const it of tc.items) {
      if (!('str' in it)) continue
      list.push({ transform: it.transform as number[], width: it.width || 0, str: it.str })
    }
    out.push(list)
    page.cleanup()
  }
  await doc.destroy()
  return out
}

function normalize(s: string): string {
  return s.replace(/\s+/g, '')
}

/**
 * Decide si un operateur doit sauter, au vu de TOUT ce qu'il dessine.
 * Le raisonnement se fait par operateur (et non par bout de texte) : un operateur
 * est indivisible, on le garde entier ou on le retire entier.
 */
type GroupSelector = (group: OpGroup, pageIndex: number) => boolean

interface RemovalReport {
  bytes: ArrayBuffer
  /** operateurs effectivement retires */
  removedGroups: number
  /** bouts de texte effectivement retires, par page */
  removedItems: { pageIndex: number; item: PageItem }[]
}

/** Coeur de la suppression : retire du flux de contenu les operateurs designes. */
async function removeGroups(data: ArrayBuffer, select: GroupSelector): Promise<RemovalReport> {
  const itemsByPage = await extractPageItems(data)
  const doc = await PDFDocument.load(data, { ignoreEncryption: true })

  const touched: {
    pageIndex: number
    original: Uint8Array
    expectedLoss: string
    items: PageItem[]
    groups: number
  }[] = []

  for (let pageIndex = 0; pageIndex < itemsByPage.length; pageIndex++) {
    const items = itemsByPage[pageIndex]
    if (!items.length) continue

    const content = readPageContent(doc, pageIndex)
    if (!content) continue

    try {
      const groups = buildGroups(items, collectShowOps(content))
      const chosen = groups.filter((g) => select(g, pageIndex))
      if (!chosen.length) continue

      const edits = chosen.flatMap((g) => editsForGroup(g))

      touched.push({
        pageIndex,
        original: content,
        expectedLoss: chosen.map((g) => g.text).join(''),
        items: chosen.flatMap((g) => g.items),
        groups: chosen.length
      })
      writePageContent(doc, pageIndex, applyEdits(content, edits))
    } catch {
      // Page recalcitrante : on la laisse telle quelle plutot que de tout perdre.
      continue
    }
  }

  if (!touched.length) {
    return { bytes: data, removedGroups: 0, removedItems: [] }
  }

  const render = async (): Promise<ArrayBuffer> => {
    const saved = await doc.save()
    const buf = new ArrayBuffer(saved.byteLength)
    new Uint8Array(buf).set(saved)
    return buf
  }

  // --- Filet de securite : verifier qu'on n'a emporte QUE la cible ---
  let out = await render()
  const after = await extractPageItems(out)
  const kept = touched.filter((t) => {
    const wasThere = normalize(itemsByPage[t.pageIndex].map((i) => i.str).join(''))
    const nowThere = normalize((after[t.pageIndex] ?? []).map((i) => i.str).join(''))
    const expected = wasThere.length - normalize(t.expectedLoss).length
    // Quelques caracteres d'ecart sont tolerables (espaces regroupes autrement),
    // la disparition d'un pan de texte voisin ne l'est pas.
    return Math.abs(nowThere.length - expected) <= 2
  })

  if (kept.length !== touched.length) {
    for (const t of touched) {
      if (!kept.includes(t)) writePageContent(doc, t.pageIndex, t.original)
    }
    out = kept.length ? await render() : data
  }

  return {
    bytes: out,
    removedGroups: kept.reduce((n, t) => n + t.groups, 0),
    removedItems: kept.flatMap((t) => t.items.map((item) => ({ pageIndex: t.pageIndex, item })))
  }
}

/**
 * L'operateur dessine-t-il le texte recherche ? On regarde ce que pdfjs a lu,
 * et aussi la chaine telle qu'elle figure dans l'operateur (pdfjs tronque
 * parfois les textes poses en diagonale, comme les filigranes).
 */
function groupMatches(
  group: OpGroup,
  needle: string,
  options: { caseSensitive?: boolean }
): boolean {
  const fold = (s: string): string => (options.caseSensitive ? s : s.toUpperCase())
  return fold(group.text).includes(needle) || fold(group.rawText).includes(needle)
}

/**
 * Supprime pour de vrai un texte designe par sa position — utilise par l'outil
 * « Modifier » quand on efface ou remplace un texte existant.
 *
 * Refuse (et le signale dans `failed`) quand le texte vise est dessine par le
 * meme operateur que du texte a conserver : dans ce cas l'appelant retombe sur
 * un masque, plutot que d'emporter la phrase entiere.
 */
export async function removeTextTargets(
  data: ArrayBuffer,
  targets: TextTarget[]
): Promise<RealRemovalResult> {
  if (!targets.length) return { bytes: data, removed: 0, failed: [] }

  const byPage = new Map<number, TextTarget[]>()
  for (const t of targets) {
    const l = byPage.get(t.pageIndex)
    if (l) l.push(t)
    else byPage.set(t.pageIndex, [t])
  }
  const isTarget = (item: PageItem, pageIndex: number): boolean => {
    const list = byPage.get(pageIndex)
    if (!list) return false
    return list.some((t) => sameOrigin(item.transform, t.transform) && t.str === item.str)
  }

  const report = await removeGroups(
    data,
    (group, pageIndex) =>
      group.items.some((it) => isTarget(it, pageIndex)) &&
      group.items.every((it) => isTarget(it, pageIndex))
  )

  const done = (t: TextTarget): boolean =>
    report.removedItems.some(
      (r) => r.pageIndex === t.pageIndex && sameOrigin(r.item.transform, t.transform)
    )
  const failed = targets.filter((t) => !done(t))

  return { bytes: report.bytes, removed: targets.length - failed.length, failed }
}

/**
 * Cherche un texte dans tout le document et le supprime reellement.
 * Utilise par la boite « Supprimer un texte recurrent » (filigranes BROUILLON,
 * DRAFT, COPIE…).
 */
export async function removeTextByContent(
  data: ArrayBuffer,
  searchText: string,
  options: { caseSensitive?: boolean } = {}
): Promise<RealRemovalResult> {
  if (!searchText.trim()) return { bytes: data, removed: 0, failed: [] }
  const needle = options.caseSensitive ? searchText : searchText.toUpperCase()
  const report = await removeGroups(data, (group) => groupMatches(group, needle, options))
  return { bytes: report.bytes, removed: report.removedGroups, failed: [] }
}

/**
 * Compte ce qui sera supprime, sans toucher au PDF (apercu de la boite de
 * dialogue), et renvoie un echantillon des blocs concernes.
 *
 * Important : l'unite supprimable est le bloc de texte indivisible, pas le mot.
 * Chercher « Villepinte » dans une phrase dessinee d'un seul tenant emporte la
 * phrase entiere — d'ou les extraits, que la boite de dialogue montre avant de
 * lancer la suppression.
 */
export async function countRemovableText(
  data: ArrayBuffer,
  searchText: string,
  options: { caseSensitive?: boolean } = {}
): Promise<{ count: number; pagesAffected: number[]; samples: string[] }> {
  if (!searchText.trim()) return { count: 0, pagesAffected: [], samples: [] }
  const needle = options.caseSensitive ? searchText : searchText.toUpperCase()
  const itemsByPage = await extractPageItems(data)
  const doc = await PDFDocument.load(data, { ignoreEncryption: true })

  let count = 0
  const pages = new Set<number>()
  const samples: string[] = []
  for (let pageIndex = 0; pageIndex < itemsByPage.length; pageIndex++) {
    const items = itemsByPage[pageIndex]
    if (!items.length) continue
    const content = readPageContent(doc, pageIndex)
    if (!content) continue
    try {
      for (const group of buildGroups(items, collectShowOps(content))) {
        if (groupMatches(group, needle, options)) {
          count++
          pages.add(pageIndex)
          const label = (group.text || group.rawText).trim()
          if (label && samples.length < 6 && !samples.includes(label)) samples.push(label)
        }
      }
    } catch {
      continue // page illisible : elle ne sera pas touchee non plus
    }
  }
  return { count, pagesAffected: [...pages].sort((a, b) => a - b), samples }
}
