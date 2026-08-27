import { Fragment, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import {
  Annotation,
  TextAnnotation,
  ImageAnnotation,
  HighlightAnnotation,
  EraserAnnotation,
  newId
} from '../lib/annotations'
import { FormField, newFieldId } from '../lib/forms'
import { Tool } from './Sidebar'
import AnnotationContextMenu, { AnnotationAction } from './AnnotationContextMenu'
import { findTextAtPoint, fontFamilyToCss, getAllTextItems, TextHit } from '../lib/textEdit'
import { sampleTextColors } from '../lib/colorSample'
import { taillePose } from '../lib/imageImport'

// Le type TextLayer n'est pas exporte dans les declarations TS de pdfjs-dist 4.x
// mais existe à runtime ; on l'aliasse en type minimal
type TextLayerCtorType = new (options: {
  textContentSource: unknown
  container: HTMLElement
  viewport: unknown
}) => { render(): Promise<void>; cancel?(): void }

interface Props {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null
  pageIndex: number
  scale: number
  tool: Tool
  annotations: Annotation[]
  onAddAnnotation: (a: Annotation) => void
  onUpdateAnnotation: (id: string, updates: Partial<Annotation>) => void
  onRemoveAnnotation: (id: string) => void
  onDuplicateAnnotation: (id: string) => void
  onCopyAnnotation: (id: string) => void
  onCutAnnotation: (id: string) => void
  onPasteAnnotation: () => void
  canPasteAnnotation: boolean
  onCommitModifyText: (
    pageIndex: number,
    hit: TextHit,
    newText: string,
    colors?: { background: string; text: string }
  ) => void
  onRotateAnnotation: (id: string, deltaDeg: number) => void
  formFields: FormField[]
  onAddFormField: (f: FormField) => void
  onRemoveFormField: (id: string) => void
  highlightColor: string
  highlightOpacity: number
  highlightMode: 'shape' | 'text'
  onSetTextSize: (n: number) => void
  selectedAnnotationId: string | null
  onSelectAnnotation: (id: string | null) => void
  ocrZoneActive: boolean
  onOcrZone: (pageIndex: number, rect: { x: number; y: number; w: number; h: number }) => void
  penColor: string
  penWidth: number
  textSize: number
  textColor: string
  signatureDataUrl: string | null
  pendingImage: import('../lib/imageImport').LoadedImage | null
  onPlaceImage: () => void
  onPlaceSignature: () => void
  isCurrent: boolean
  onClick: () => void
}

interface DraftHighlight {
  x: number
  y: number
  w: number
  h: number
}

interface DraftPen {
  points: { x: number; y: number }[]
}

interface PendingText {
  x: number
  y: number
  value: string
}

export default function PageCanvas({
  pdfDoc,
  pageIndex,
  scale,
  tool,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  onDuplicateAnnotation,
  onCopyAnnotation,
  onCutAnnotation,
  onPasteAnnotation,
  canPasteAnnotation,
  onCommitModifyText,
  onRotateAnnotation,
  formFields,
  onAddFormField,
  onRemoveFormField,
  highlightColor,
  highlightOpacity,
  highlightMode,
  selectedAnnotationId,
  onSelectAnnotation,
  ocrZoneActive,
  onOcrZone,
  penColor,
  penWidth,
  textSize,
  textColor,
  onSetTextSize,
  signatureDataUrl,
  pendingImage,
  onPlaceImage,
  onPlaceSignature,
  isCurrent,
  onClick
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  // true uniquement quand le canvas contient un rendu pdf.js termine (pas pendant
  // un re-render ou le bitmap est transitoirement vide) → garde l'echantillonnage
  // couleur contre la lecture d'un canvas transparent (pave noir).
  const renderedRef = useRef(false)
  const [pageSize, setPageSize] = useState<{ w: number; h: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    annotationId: string
  } | null>(null)
  const [modifyEditor, setModifyEditor] = useState<{
    hit: TextHit
    draft: string
    colors?: { background: string; text: string }
  } | null>(null)
  const [allTextItems, setAllTextItems] = useState<TextHit[]>([])

  // En mode modify-text, charge tous les items texte de la page pour les rendre cliquables
  useEffect(() => {
    if (tool !== 'modify-text' || !pdfDoc) {
      setAllTextItems([])
      return
    }
    let cancelled = false
    getAllTextItems(pdfDoc, pageIndex)
      .then((items) => {
        if (!cancelled) setAllTextItems(items)
      })
      .catch(() => {
        if (!cancelled) setAllTextItems([])
      })
    return () => {
      cancelled = true
    }
  }, [tool, pdfDoc, pageIndex])

  function openAnnotationMenu(x: number, y: number, id: string): void {
    setContextMenu({ x, y, annotationId: id })
  }

  function dispatchMenuAction(action: AnnotationAction): void {
    if (!contextMenu) return
    const id = contextMenu.annotationId
    if (action === 'copy') onCopyAnnotation(id)
    else if (action === 'cut') onCutAnnotation(id)
    else if (action === 'paste') onPasteAnnotation()
    else if (action === 'duplicate') onDuplicateAnnotation(id)
    else if (action === 'remove') onRemoveAnnotation(id)
    else if (action === 'rotate-cw') onRotateAnnotation(id, -90) // visuel horaire = -90 PDF
    else if (action === 'rotate-ccw') onRotateAnnotation(id, 90) // visuel anti-horaire = +90 PDF
  }
  const [draftHL, setDraftHL] = useState<DraftHighlight | null>(null)
  const [draftPen, setDraftPen] = useState<DraftPen | null>(null)
  const [pendingText, setPendingText] = useState<PendingText | null>(null)

  // Rendu du PDF a chaque changement de page/scale
  useEffect(() => {
    if (!pdfDoc) return
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null
    renderedRef.current = false // canvas en cours de (re)rendu : pas d'echantillon
    ;(async () => {
      const page = await pdfDoc.getPage(pageIndex + 1)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas) return
      // Rendu haute densite : on dessine a la resolution physique de l'ecran
      // (Retina = 2x) puis on affiche a la taille logique → texte beaucoup plus net.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      })
      renderTask = task
      try {
        await task.promise
      } catch {
        return // rendu annule (changement de scale/page) : on sort proprement
      }
      if (cancelled) return
      renderedRef.current = true // canvas pret : echantillonnage couleur autorise
      setPageSize({ w: viewport.width, h: viewport.height })

      // Render text layer (texte transparent selectable)
      const textLayerEl = textLayerRef.current
      if (textLayerEl) {
        textLayerEl.innerHTML = ''
        textLayerEl.style.width = `${viewport.width}px`
        textLayerEl.style.height = `${viewport.height}px`
        try {
          // pdfjs-dist 4.x : la classe TextLayer est exportee
          const TextLayerCtor = (pdfjsLib as unknown as { TextLayer?: TextLayerCtorType })
            .TextLayer
          if (TextLayerCtor) {
            const stream =
              typeof (page as unknown as { streamTextContent?: () => unknown }).streamTextContent === 'function'
                ? (page as unknown as { streamTextContent: () => unknown }).streamTextContent()
                : await page.getTextContent()
            const tl = new TextLayerCtor({
              textContentSource: stream as never,
              container: textLayerEl,
              viewport
            })
            await tl.render()
          }
        } catch (err) {
          console.warn('[textLayer] echec rendu :', err)
        }
      }
    })()
    return () => {
      cancelled = true
      renderedRef.current = false
      try {
        renderTask?.cancel()
      } catch {
        /* ignore */
      }
    }
  }, [pdfDoc, pageIndex, scale])

  // En mode Surligner texte : ecoute la fin de selection pour creer des highlights
  useEffect(() => {
    if (tool !== 'annotate-highlight' || highlightMode !== 'text') return
    if (ocrZoneActive) return
    const tlEl = textLayerRef.current
    const containerEl = containerRef.current
    if (!tlEl || !containerEl) return

    let downInTextLayer = false
    const onDown = (e: MouseEvent) => {
      downInTextLayer = tlEl.contains(e.target as Node)
    }
    const onUp = () => {
      if (!downInTextLayer) return
      downInTextLayer = false
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return

      // Verifie que la selection appartient bien a notre text layer
      let owned = false
      for (let i = 0; i < sel.rangeCount; i++) {
        const r = sel.getRangeAt(i)
        let node: Node | null = r.commonAncestorContainer
        while (node) {
          if (node === tlEl) {
            owned = true
            break
          }
          node = node.parentNode
        }
        if (owned) break
      }
      if (!owned) return

      const containerRect = containerEl.getBoundingClientRect()
      const range = sel.getRangeAt(0)
      const rects = Array.from(range.getClientRects())
      // Fusionne les rects qui se touchent sur la meme ligne (evite trop de petits highlights)
      const norm: { x: number; y: number; w: number; h: number }[] = []
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue
        const left = Math.max(0, r.left - containerRect.left)
        const top = Math.max(0, r.top - containerRect.top)
        const right = Math.min(containerRect.width, r.right - containerRect.left)
        const bottom = Math.min(containerRect.height, r.bottom - containerRect.top)
        const w = right - left
        const h = bottom - top
        if (w <= 0 || h <= 0) continue
        norm.push({
          x: left / containerRect.width,
          y: top / containerRect.height,
          w: w / containerRect.width,
          h: h / containerRect.height
        })
      }
      if (norm.length === 0) return

      for (const r of norm) {
        onAddAnnotation({
          id: newId(),
          kind: 'highlight',
          pageIndex,
          rect: r,
          color: highlightColor,
          opacity: highlightOpacity
        })
      }
      sel.removeAllRanges()
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('mouseup', onUp)
    }
  }, [tool, highlightMode, ocrZoneActive, pageIndex, highlightColor, highlightOpacity, onAddAnnotation])

  // Coords mouse → normalisees [0,1]
  function toNorm(e: React.MouseEvent): { x: number; y: number } {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y))
    }
  }

  // Ouvre l'editeur "Modifier" en echantillonnant la couleur reelle du fond et du
  // texte sous le hit (rendu pdf.js deja termine au moment du clic).
  function openModifyEditor(hit: TextHit): void {
    let colors: { background: string; text: string } | undefined
    const canvas = canvasRef.current
    // N'echantillonne QUE si le canvas contient un rendu termine (sinon on lirait
    // un bitmap transparent → pave noir). Sinon fallback blanc/noir propre.
    if (canvas && renderedRef.current) {
      colors = sampleTextColors(canvas, {
        x: hit.x,
        y: hit.y,
        w: hit.width,
        h: hit.height
      })
    }
    setModifyEditor({ hit, draft: hit.text, colors })
  }

  function onMouseDown(e: React.MouseEvent) {
    if (!isCurrent) onClick()
    if (ocrZoneActive) {
      const { x, y } = toNorm(e)
      setDraftHL({ x, y, w: 0, h: 0 })
      return
    }
    if (
      (tool === 'annotate-highlight' && highlightMode === 'shape') ||
      tool === 'form-text' ||
      tool === 'form-checkbox' ||
      tool === 'eraser'
    ) {
      const { x, y } = toNorm(e)
      setDraftHL({ x, y, w: 0, h: 0 })
    } else if (tool === 'annotate-pen') {
      const p = toNorm(e)
      setDraftPen({ points: [p] })
    } else if (tool === 'annotate-text') {
      const p = toNorm(e)
      setPendingText({ x: p.x, y: p.y, value: '' })
    } else if (tool === 'modify-text' && pdfDoc) {
      const p = toNorm(e)
      // Trouve le texte sous le clic — fire-and-forget (onMouseDown ne peut pas etre async)
      findTextAtPoint(pdfDoc, pageIndex, p.x, p.y).then((hit) => {
        if (hit) openModifyEditor(hit)
      })
    } else if (tool === 'sign' && signatureDataUrl) {
      const p = toNorm(e)
      onAddAnnotation({
        id: newId(),
        kind: 'image',
        pageIndex,
        x: p.x - 0.1,
        y: p.y - 0.025,
        w: 0.2,
        h: 0.05,
        dataUrl: signatureDataUrl
      })
      onPlaceSignature()
    } else if (tool === 'image' && pendingImage) {
      const p = toNorm(e)
      // taille de depart proportionnee a l'image ET a la page, puis centree sur
      // le point clique — et ramenee dans la page si on a clique pres d'un bord
      const { w, h } = taillePose(pendingImage, pageSize ? pageSize.w / pageSize.h : 1)
      onAddAnnotation({
        id: newId(),
        kind: 'image',
        pageIndex,
        x: Math.max(0, Math.min(1 - w, p.x - w / 2)),
        y: Math.max(0, Math.min(1 - h, p.y - h / 2)),
        w,
        h,
        dataUrl: pendingImage.dataUrl
      })
      onPlaceImage()
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    if (draftHL) {
      const { x, y } = toNorm(e)
      setDraftHL({
        x: Math.min(draftHL.x, x),
        y: Math.min(draftHL.y, y),
        w: Math.abs(x - draftHL.x),
        h: Math.abs(y - draftHL.y)
      })
    } else if (draftPen) {
      const p = toNorm(e)
      setDraftPen({ points: [...draftPen.points, p] })
    }
  }

  function onMouseUp() {
    if (draftHL && draftHL.w > 0.005 && draftHL.h > 0.005) {
      if (ocrZoneActive) {
        onOcrZone(pageIndex, draftHL)
      } else if (tool === 'eraser') {
        onAddAnnotation({
          id: newId(),
          kind: 'eraser',
          pageIndex,
          rect: draftHL,
          color: '#FFFFFF'
        })
      } else if (tool === 'annotate-highlight') {
        onAddAnnotation({
          id: newId(),
          kind: 'highlight',
          pageIndex,
          rect: draftHL,
          color: highlightColor,
          opacity: highlightOpacity
        })
      } else if (tool === 'form-text' || tool === 'form-checkbox') {
        const kind = tool === 'form-text' ? 'text' : 'checkbox'
        const count = formFields.filter((f) => f.kind === kind).length + 1
        const name = `${kind === 'text' ? 'champ' : 'case'}_${count}`
        onAddFormField({
          id: newFieldId(),
          kind,
          pageIndex,
          name,
          x: draftHL.x,
          y: draftHL.y,
          w: draftHL.w,
          h: kind === 'checkbox' ? Math.min(draftHL.h, draftHL.w) : draftHL.h
        })
      }
    }
    setDraftHL(null)

    if (draftPen && draftPen.points.length > 1) {
      onAddAnnotation({
        id: newId(),
        kind: 'pen',
        pageIndex,
        points: draftPen.points,
        color: penColor,
        width: penWidth
      })
    }
    setDraftPen(null)
  }

  function commitText() {
    if (pendingText && pendingText.value.trim()) {
      onAddAnnotation({
        id: newId(),
        kind: 'text',
        pageIndex,
        x: pendingText.x,
        y: pendingText.y,
        text: pendingText.value,
        size: textSize,
        color: textColor
      })
    }
    setPendingText(null)
  }

  const pageAnnotations = annotations.filter((a) => a.pageIndex === pageIndex)
  const pageFields = formFields.filter((f) => f.pageIndex === pageIndex)
  const interactive =
    ocrZoneActive ||
    (tool === 'annotate-highlight' && highlightMode === 'shape') ||
    tool === 'annotate-pen' ||
    tool === 'annotate-text' ||
    tool === 'modify-text' ||
    tool === 'form-text' ||
    tool === 'form-checkbox' ||
    tool === 'eraser' ||
    (tool === 'sign' && signatureDataUrl !== null) ||
    (tool === 'image' && pendingImage !== null)
  const textLayerSelectable =
    !ocrZoneActive &&
    ((tool === 'annotate-highlight' && highlightMode === 'text') ||
      tool === 'pages' ||
      tool === 'ocr')
  // En modify-text on veut que le clic aille à l'overlay interactive (pas à la text layer)

  return (
    <div
      ref={containerRef}
      className={[
        'relative bg-white shadow-md mx-auto select-none',
        isCurrent ? 'ring-2 ring-pretto/40' : ''
      ].join(' ')}
      style={{ width: pageSize?.w, height: pageSize?.h }}
      onClick={onClick}
    >
      <canvas ref={canvasRef} className="block" />

      {/* Couche de texte transparente — selectable en mode Surligner, Pages et OCR */}
      <div
        ref={textLayerRef}
        className={['textLayer', textLayerSelectable ? 'selectable' : ''].join(' ')}
      />

      {/* Overlay annotations existantes */}
      {pageSize && (
        <svg
          className="absolute inset-0 pointer-events-none"
          width={pageSize.w}
          height={pageSize.h}
          viewBox={`0 0 ${pageSize.w} ${pageSize.h}`}
        >
          {pageAnnotations.map((a) => {
            if (a.kind === 'pen') {
              const d = a.points
                .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x * pageSize.w},${p.y * pageSize.h}`)
                .join(' ')
              return (
                <path
                  key={a.id}
                  d={d}
                  stroke={a.color}
                  strokeWidth={a.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  opacity={0.9}
                />
              )
            }
            // text et image sont rendus en HTML pour pouvoir etre draggables (voir plus bas)
            return null
          })}

          {/* Draft (en cours) */}
          {draftHL && tool === 'annotate-highlight' && !ocrZoneActive && (
            <rect
              x={draftHL.x * pageSize.w}
              y={draftHL.y * pageSize.h}
              width={draftHL.w * pageSize.w}
              height={draftHL.h * pageSize.h}
              fill={highlightColor}
              opacity={highlightOpacity}
            />
          )}
          {draftHL && tool === 'eraser' && !ocrZoneActive && (
            <rect
              x={draftHL.x * pageSize.w}
              y={draftHL.y * pageSize.h}
              width={draftHL.w * pageSize.w}
              height={draftHL.h * pageSize.h}
              fill="white"
              stroke="#0C806E"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          )}
          {draftHL &&
            (tool === 'form-text' || tool === 'form-checkbox' || ocrZoneActive) && (
              <rect
                x={draftHL.x * pageSize.w}
                y={draftHL.y * pageSize.h}
                width={draftHL.w * pageSize.w}
                height={draftHL.h * pageSize.h}
                fill={ocrZoneActive ? 'rgba(152,175,36,0.1)' : 'none'}
                stroke={ocrZoneActive ? '#98AF24' : '#0C806E'}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            )}
          {draftPen && draftPen.points.length > 1 && (
            <path
              d={draftPen.points
                .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x * pageSize.w},${p.y * pageSize.h}`)
                .join(' ')}
              stroke={penColor}
              strokeWidth={penWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              opacity={0.9}
            />
          )}
        </svg>
      )}

      {/* Annotations surlignage, texte et image (signature) — HTML pour etre draggables */}
      {pageSize &&
        pageAnnotations.map((a) => {
          if (a.kind === 'highlight') {
            return (
              <DraggableHighlightAnnotation
                key={a.id}
                a={a}
                pageW={pageSize.w}
                pageH={pageSize.h}
                isSelected={selectedAnnotationId === a.id}
                onSelect={() => onSelectAnnotation(a.id)}
                onUpdate={onUpdateAnnotation}
                onRemove={onRemoveAnnotation}
                onDuplicate={onDuplicateAnnotation}
                onContextMenu={openAnnotationMenu}
              />
            )
          }
          if (a.kind === 'eraser') {
            return (
              <DraggableEraserAnnotation
                key={a.id}
                a={a}
                pageW={pageSize.w}
                pageH={pageSize.h}
                isSelected={selectedAnnotationId === a.id}
                onSelect={() => onSelectAnnotation(a.id)}
                onUpdate={onUpdateAnnotation}
                onRemove={onRemoveAnnotation}
                onDuplicate={onDuplicateAnnotation}
                onContextMenu={openAnnotationMenu}
              />
            )
          }
          if (a.kind === 'text') {
            return (
              <Fragment key={a.id}>
                {/* Masque opaque integre (outil Modifier) : rendu en sibling, en
                    coords page, TOUJOURS sous le texte (z 9 < texte 10/14). Mask et
                    texte derivent de la meme annotation et bougent ensemble (drag). */}
                {a.background && a.backgroundRect && (
                  <TextMaskRect
                    rect={a.backgroundRect}
                    rotation={a.rotation}
                    color={a.background}
                    pageW={pageSize.w}
                    pageH={pageSize.h}
                  />
                )}
                <DraggableTextAnnotation
                  a={a}
                  pageW={pageSize.w}
                  pageH={pageSize.h}
                  scale={scale}
                  isSelected={selectedAnnotationId === a.id}
                  onSelect={() => onSelectAnnotation(a.id)}
                  onUpdate={onUpdateAnnotation}
                  onRemove={onRemoveAnnotation}
                  onDuplicate={onDuplicateAnnotation}
                  onContextMenu={openAnnotationMenu}
                />
              </Fragment>
            )
          }
          if (a.kind === 'image') {
            return (
              <DraggableImageAnnotation
                key={a.id}
                a={a}
                pageW={pageSize.w}
                pageH={pageSize.h}
                isSelected={selectedAnnotationId === a.id}
                onSelect={() => onSelectAnnotation(a.id)}
                onUpdate={onUpdateAnnotation}
                onRemove={onRemoveAnnotation}
                onDuplicate={onDuplicateAnnotation}
                onContextMenu={openAnnotationMenu}
              />
            )
          }
          return null
        })}

      {/* Marqueurs de form fields existants (rectangles pointillés) */}
      {pageSize &&
        pageFields.map((f) => (
          <div
            key={f.id}
            className="absolute group"
            style={{
              left: f.x * pageSize.w,
              top: f.y * pageSize.h,
              width: f.w * pageSize.w,
              height: f.h * pageSize.h,
              zIndex: 6
            }}
          >
            <div className="absolute inset-0 border-2 border-dashed border-pretto bg-pretto/5 rounded-sm pointer-events-none" />
            <div className="absolute -top-5 left-0 text-[10px] bg-pretto text-white px-1.5 py-0.5 rounded font-medium whitespace-nowrap">
              {f.kind === 'text' ? '📝' : '☐'} {f.name}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRemoveFormField(f.id)
              }}
              className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              title="Supprimer ce champ"
            >
              ✕
            </button>
          </div>
        ))}

      {/* Mode Modifier : overlay sur chaque bloc de texte pour montrer où cliquer */}
      {tool === 'modify-text' &&
        pageSize &&
        !modifyEditor &&
        allTextItems.map((item, idx) => {
          const rotated = Math.abs(item.rotation) > 0.5
          return (
            <div
              key={`txt-${idx}`}
              className="absolute border border-dashed border-pretto/40 hover:border-pretto hover:bg-pretto/15 transition-colors"
              style={{
                left: item.baselineX * pageSize.w,
                top: item.baselineY * pageSize.h,
                width: item.textWidth * pageSize.w,
                height: item.textHeight * pageSize.h,
                transform: rotated
                  ? `rotate(${-item.rotation}deg) translateY(-100%)`
                  : 'translateY(-100%)',
                transformOrigin: '0 100%',
                zIndex: 6,
                cursor: 'text'
              }}
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                openModifyEditor(item)
              }}
              title={`Cliquer pour modifier : "${item.text.substring(0, 50)}${
                item.text.length > 50 ? '…' : ''
              }"`}
            />
          )
        })}

      {/* Couche de capture event mouse — uniquement quand un tool est actif ET pas de texte en cours */}
      {interactive && pageSize && !pendingText && (
        <div
          className="absolute inset-0"
          style={{
            cursor:
              tool === 'annotate-text' || tool === 'modify-text' ? 'text' : 'crosshair',
            zIndex: 5
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />
      )}

      {/* Input texte (en cours) */}
      {pendingText && pageSize && (
        <div
          className="absolute"
          style={{
            left: pendingText.x * pageSize.w,
            top: pendingText.y * pageSize.h,
            zIndex: 20
          }}
        >
          {/* Mini barre d'outils au-dessus : taille de police */}
          <div className="flex items-center gap-1 mb-1 bg-white shadow-md rounded px-2 py-1 border border-pretto/30 text-xs">
            <button
              onClick={() => onSetTextSize(Math.max(6, textSize - 2))}
              className="w-6 h-6 rounded hover:bg-black/5 font-semibold text-sm"
              title="Réduire la taille"
            >
              A-
            </button>
            <input
              type="number"
              min={6}
              max={72}
              value={textSize}
              onChange={(e) => onSetTextSize(parseInt(e.target.value, 10) || 14)}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-12 px-1 py-0.5 border border-black/15 rounded text-center text-xs"
            />
            <button
              onClick={() => onSetTextSize(Math.min(72, textSize + 2))}
              className="w-6 h-6 rounded hover:bg-black/5 font-bold text-base"
              title="Augmenter la taille"
            >
              A+
            </button>
            <span className="text-[10px] text-black/50 ml-1">pt</span>
          </div>
          <textarea
            ref={(el) => {
              if (el && document.activeElement !== el) {
                requestAnimationFrame(() => el.focus())
              }
            }}
            rows={1}
            value={pendingText.value}
            onChange={(e) => setPendingText({ ...pendingText, value: e.target.value })}
            onBlur={commitText}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                setPendingText(null)
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                commitText()
              }
              // Shift+Enter = nouvelle ligne
            }}
            placeholder="Tape ton texte…"
            className="border-2 border-pretto rounded px-2 py-0.5 outline-none bg-white shadow-lg resize-none whitespace-nowrap"
            style={{
              fontSize: textSize * scale,
              color: textColor,
              fontFamily: 'Helvetica, Arial, sans-serif',
              minWidth: 200,
              height: textSize * scale * 1.4 + 12,
              lineHeight: '1.2'
            }}
          />
          <div className="text-[10px] text-black bg-pretto/90 text-white mt-1 px-1.5 py-0.5 rounded inline-block">
            Entrée valider · Maj+Entrée nouvelle ligne · Echap annuler
          </div>
        </div>
      )}

      {/* Editeur "Modifier texte" — apparait sur clic d'un texte du PDF */}
      {modifyEditor &&
        pageSize &&
        (() => {
          const hit = modifyEditor.hit
          const fs = hit.fontSize * scale
          const bg = modifyEditor.colors?.background ?? '#FFFFFF'

          // Distance du haut de la ligne CSS a la ligne de base, en em.
          // C'est ce qui permet de poser l'editeur PILE sur le texte d'origine :
          // pdfjs donne la ligne de base, le navigateur raisonne en haut de ligne.
          // Valeurs MESUREES dans Chromium avec les piles de polices reelles
          // (cf. fontFamilyToCss), et non des metriques theoriques.
          const RATIO_BASELINE = { helvetica: 0.8375, times: 0.8375, courier: 0.7625 }
          const BORDURE = 2

          const baseline = hit.baselineY * pageSize.h
          const gauche = hit.x * pageSize.w
          const hautTexte = baseline - RATIO_BASELINE[hit.fontFamily] * fs
          // Le cache doit couvrir les jambages (g, p, q) du texte d'origine.
          const cacheTop = baseline - fs * 0.9
          const cacheH = fs * 1.2
          const cacheW = Math.max(hit.width * pageSize.w, 4) + 3

          const tourne = Math.abs(hit.rotation) > 0.5
          const pivot = tourne
            ? {
                transform: `rotate(${-hit.rotation}deg)`,
                transformOrigin: `0px ${baseline - hautTexte + BORDURE}px`
              }
            : undefined

          const valider = (): void => {
            onCommitModifyText(pageIndex, hit, modifyEditor.draft, modifyEditor.colors)
            setModifyEditor(null)
          }

          return (
            <>
              {/* Cache couleur-fond : masque le texte d'origine pendant l'edition,
                  sinon on lit les deux en meme temps (l'ancien depassant sous
                  l'editeur). C'est ce qui donne l'impression d'editer en place. */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: gauche - 1,
                  top: cacheTop,
                  width: cacheW,
                  height: cacheH,
                  backgroundColor: bg,
                  zIndex: 24,
                  ...(tourne
                    ? {
                        transform: `rotate(${-hit.rotation}deg)`,
                        transformOrigin: `1px ${baseline - cacheTop}px`
                      }
                    : {})
                }}
              />
              <div
                className="absolute"
                style={{
                  left: gauche,
                  top: hautTexte - BORDURE,
                  zIndex: 25,
                  ...pivot
                }}
              >
                <textarea
                  ref={(el) => {
                    if (el && document.activeElement !== el) {
                      requestAnimationFrame(() => {
                        el.focus()
                        el.setSelectionRange(0, el.value.length)
                      })
                    }
                  }}
                  rows={1}
                  value={modifyEditor.draft}
                  onChange={(e) => setModifyEditor({ ...modifyEditor, draft: e.target.value })}
                  onBlur={() => {
                    if (modifyEditor.draft !== hit.text) valider()
                    else setModifyEditor(null)
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Escape') {
                      setModifyEditor(null)
                    } else if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (modifyEditor.draft !== hit.text) valider()
                      else setModifyEditor(null)
                    }
                    // Maj+Entree = nouvelle ligne (comportement par defaut)
                  }}
                  className="border-2 border-pretto/70 rounded-sm outline-none resize-none whitespace-nowrap"
                  style={{
                    fontFamily: fontFamilyToCss(hit.fontFamily),
                    fontSize: fs,
                    fontWeight: hit.bold ? 'bold' : 'normal',
                    fontStyle: hit.italic ? 'italic' : 'normal',
                    color: modifyEditor.colors?.text ?? '#000000',
                    // Fond transparent : le cache derriere fait deja le travail, et
                    // on evite ainsi de recouvrir ce qui se trouve a droite.
                    backgroundColor: 'transparent',
                    minWidth: cacheW,
                    padding: 0,
                    lineHeight: '1',
                    boxSizing: 'content-box',
                    height: fs * 1.25,
                    overflow: 'hidden'
                  }}
                />
                <div className="mt-1 flex items-center gap-2 whitespace-nowrap">
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={valider}
                    className="rounded bg-pretto px-1.5 py-0.5 text-[10px] text-white hover:bg-pretto/90"
                    title="Transforme ce texte en bloc déplaçable : tu pourras ensuite le glisser où tu veux"
                  >
                    ✥ Détacher pour déplacer
                  </button>
                  <span className="rounded bg-pretto/90 px-1.5 py-0.5 text-[10px] text-white">
                    Entrée valider · Echap annuler · {hit.fontFamily}
                    {hit.bold ? ' bold' : ''}
                    {hit.italic ? ' italic' : ''} {Math.round(hit.fontSize)}pt
                  </span>
                </div>
              </div>
            </>
          )
        })()}

      {/* Menu contextuel sur clic-droit d'une annotation */}
      {contextMenu && (
        <AnnotationContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canPaste={canPasteAnnotation}
          onAction={dispatchMenuAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

// ---- Sous-composants draggables ----

/**
 * Masque opaque integre au texte de l'outil "Modifier" (rendu en sibling, coords page).
 * Memes conventions que l'ancien eraser : rotaté → pivot baseline-left + translateY(-100%) ;
 * sinon top-left. z-index 9 : toujours sous le texte (10/14), au-dessus de l'image (8).
 */
function TextMaskRect({
  rect,
  rotation,
  color,
  pageW,
  pageH
}: {
  rect: { x: number; y: number; w: number; h: number }
  rotation?: number
  color: string
  pageW: number
  pageH: number
}): JSX.Element {
  const rotated = rotation !== undefined && Math.abs(rotation) > 0.001
  const rotatedStyle = rotated
    ? {
        transform: `rotate(${-rotation!}deg) translateY(-100%)`,
        transformOrigin: '0 100%' as const
      }
    : {}
  return (
    <div
      aria-hidden
      className="absolute"
      style={{
        left: rect.x * pageW,
        top: rect.y * pageH,
        width: rect.w * pageW,
        height: rect.h * pageH,
        backgroundColor: color,
        zIndex: 9,
        pointerEvents: 'none',
        ...rotatedStyle
      }}
    />
  )
}

interface DragTextProps {
  a: TextAnnotation
  pageW: number
  pageH: number
  scale: number
  isSelected: boolean
  onSelect: () => void
  onUpdate: (id: string, updates: Partial<Annotation>) => void
  onRemove: (id: string) => void
  onDuplicate: (id: string) => void
  onContextMenu: (x: number, y: number, id: string) => void
}

function DraggableTextAnnotation({
  a,
  pageW,
  pageH,
  scale,
  isSelected,
  onSelect,
  onUpdate,
  onRemove,
  onDuplicate,
  onContextMenu
}: DragTextProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(a.text)
  const dragging = useRef<{
    startX: number
    startY: number
    baseX: number
    baseY: number
    baseBg: { x: number; y: number; w: number; h: number } | null
  } | null>(null)
  const [hovered, setHovered] = useState(false)

  function onMouseDown(e: React.MouseEvent) {
    if (editing) return
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    dragging.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: a.x,
      baseY: a.y,
      baseBg: a.backgroundRect ? { ...a.backgroundRect } : null
    }
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const dx = (ev.clientX - dragging.current.startX) / pageW
      const dy = (ev.clientY - dragging.current.startY) / pageH
      const updates: Partial<TextAnnotation> = {
        x: Math.max(0, Math.min(1, dragging.current.baseX + dx)),
        y: Math.max(0, Math.min(1, dragging.current.baseY + dy))
      }
      // Le fond integre suit le texte (coords absolues maj pour le save)
      if (dragging.current.baseBg) {
        updates.backgroundRect = {
          x: dragging.current.baseBg.x + dx,
          y: dragging.current.baseBg.y + dy,
          w: dragging.current.baseBg.w,
          h: dragging.current.baseBg.h
        }
      }
      onUpdate(a.id, updates as Partial<Annotation>)
    }
    const onUp = () => {
      dragging.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  if (editing) {
    return (
      <div
        className="absolute"
        style={{ left: a.x * pageW, top: a.y * pageH, zIndex: 18 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <textarea
          ref={(el) => el?.focus()}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          onBlur={() => {
            onUpdate(a.id, { text: draftText } as Partial<Annotation>)
            setEditing(false)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') {
              setDraftText(a.text)
              setEditing(false)
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onUpdate(a.id, { text: draftText } as Partial<Annotation>)
              setEditing(false)
            }
          }}
          className="border-2 border-pretto rounded p-1 outline-none bg-white shadow-lg"
          style={{
            fontSize: a.size * scale,
            color: a.color,
            fontFamily: 'Helvetica, Arial, sans-serif',
            minWidth: 160,
            minHeight: a.size * scale * 1.6
          }}
        />
      </div>
    )
  }

  // Mode baseline-left dès que rotation est defini (même =0)
  const useBaseline = a.rotation !== undefined
  const rotatedStyle = useBaseline
    ? {
        // (a.x, a.y) = baseline-left ; box monte depuis ce point
        transform: `rotate(${-(a.rotation || 0)}deg) translateY(-100%)`,
        transformOrigin: '0 100%'
      }
    : {}

  return (
    <div
      className="absolute group"
      style={{
        left: a.x * pageW,
        top: a.y * pageH,
        // Le texte est TOUJOURS au-dessus des masques/erasers (z 4/6) pour ne
        // jamais etre recouvert (bug historique : eraser z9 > texte z8).
        zIndex: isSelected ? 14 : 10,
        cursor: 'move',
        padding: 2,
        border: isSelected
          ? '2px solid #0C806E'
          : hovered
            ? '1px dashed rgba(12,128,110,0.6)'
            : '1px dashed transparent',
        borderRadius: 3,
        ...rotatedStyle
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraftText(a.text)
        setEditing(true)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
        onContextMenu(e.clientX, e.clientY, a.id)
      }}
      title="Glisse pour déplacer · Double-clic pour modifier · Clic-droit pour menu"
    >
      <pre
        className="m-0 select-none"
        style={{
          fontSize: a.size * scale,
          color: a.color,
          fontFamily: fontFamilyToCss(a.fontFamily ?? 'helvetica'),
          fontWeight: a.bold ? 'bold' : 'normal',
          fontStyle: a.italic ? 'italic' : 'normal',
          whiteSpace: 'pre',
          lineHeight: 1.25
        }}
      >
        {a.text}
      </pre>
      {isSelected && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDuplicate(a.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute -top-2 -right-9 w-6 h-6 bg-pretto text-white rounded-full text-xs flex items-center justify-center shadow-md ring-2 ring-white hover:scale-110 transition-transform"
            title="Dupliquer"
          >
            ⧉
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRemove(a.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full text-xs flex items-center justify-center shadow-md ring-2 ring-white hover:scale-110 transition-transform"
            title="Supprimer"
          >
            ✕
          </button>
        </>
      )}
    </div>
  )
}

interface DragImageProps {
  a: ImageAnnotation
  pageW: number
  pageH: number
  isSelected: boolean
  onSelect: () => void
  onUpdate: (id: string, updates: Partial<Annotation>) => void
  onRemove: (id: string) => void
  onDuplicate: (id: string) => void
  onContextMenu: (x: number, y: number, id: string) => void
}

function DraggableImageAnnotation({
  a,
  pageW,
  pageH,
  isSelected,
  onSelect,
  onUpdate,
  onRemove,
  onDuplicate,
  onContextMenu
}: DragImageProps): JSX.Element {
  const dragging = useRef<{
    mode: 'move' | 'resize' | 'rotate'
    startX: number
    startY: number
    baseX: number
    baseY: number
    baseW: number
    baseH: number
    /** rotation au debut du geste, et angle souris correspondant (degres) */
    baseRotation: number
    baseAngle: number
  } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  function startDrag(mode: 'move' | 'resize' | 'rotate') {
    return (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      onSelect()
      const rect = boxRef.current?.getBoundingClientRect()
      const centre = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: e.clientX, y: e.clientY }
      dragging.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        baseX: a.x,
        baseY: a.y,
        baseW: a.w,
        baseH: a.h,
        baseRotation: a.rotation ?? 0,
        baseAngle: (Math.atan2(e.clientY - centre.y, e.clientX - centre.x) * 180) / Math.PI
      }
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return
        const dx = (ev.clientX - dragging.current.startX) / pageW
        const dy = (ev.clientY - dragging.current.startY) / pageH
        if (dragging.current.mode === 'rotate') {
          const angle = (Math.atan2(ev.clientY - centre.y, ev.clientX - centre.x) * 180) / Math.PI
          // le repere PDF tourne dans l'autre sens que l'ecran, d'ou le signe
          let rot = dragging.current.baseRotation - (angle - dragging.current.baseAngle)
          // Maj enfoncee : on cale sur des multiples de 15°
          if (ev.shiftKey) rot = Math.round(rot / 15) * 15
          rot = ((rot % 360) + 360) % 360
          onUpdate(a.id, { rotation: rot } as Partial<Annotation>)
        } else if (dragging.current.mode === 'move') {
          onUpdate(a.id, {
            x: Math.max(0, Math.min(1 - dragging.current.baseW, dragging.current.baseX + dx)),
            y: Math.max(0, Math.min(1 - dragging.current.baseH, dragging.current.baseY + dy))
          } as Partial<Annotation>)
        } else {
          // resize : preserve ratio
          const ratio = dragging.current.baseW / dragging.current.baseH
          const newW = Math.max(0.02, Math.min(1 - a.x, dragging.current.baseW + dx))
          onUpdate(a.id, {
            w: newW,
            h: newW / ratio
          } as Partial<Annotation>)
        }
      }
      const onUp = () => {
        dragging.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
  }

  return (
    <div
      className="absolute group"
      style={{
        left: a.x * pageW,
        top: a.y * pageH,
        width: a.w * pageW,
        height: a.h * pageH,
        zIndex: isSelected ? 12 : 8,
        cursor: 'move',
        outline: isSelected ? '2px solid #0C806E' : 'none',
        outlineOffset: 1,
        transform: a.rotation ? `rotate(${-a.rotation}deg)` : undefined,
        transformOrigin: '50% 50%'
      }}
      ref={boxRef}
      onMouseDown={startDrag('move')}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
        onContextMenu(e.clientX, e.clientY, a.id)
      }}
      title="Glisse pour déplacer · coin bas-droit pour redimensionner · poignée du haut pour pivoter (Maj = par 15°) · clic-droit pour le menu"
    >
      <img
        src={a.dataUrl}
        alt=""
        className="block w-full h-full object-contain select-none pointer-events-none"
        draggable={false}
      />
      <div className="absolute inset-0 border border-dashed border-transparent group-hover:border-pretto/60 rounded-sm" />
      {isSelected && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDuplicate(a.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute -top-2 -right-9 w-6 h-6 bg-pretto text-white rounded-full text-xs flex items-center justify-center shadow-md ring-2 ring-white hover:scale-110 transition-transform"
            title="Dupliquer"
          >
            ⧉
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRemove(a.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full text-xs flex items-center justify-center shadow-md ring-2 ring-white hover:scale-110 transition-transform"
            title="Supprimer"
          >
            ✕
          </button>
          <div
            onMouseDown={startDrag('resize')}
            className="absolute -bottom-1 -right-1 w-3 h-3 bg-pretto rounded-sm cursor-nwse-resize"
            title="Redimensionner (les proportions sont conservées)"
          />
          {/* Poignee de rotation : tige + pastille au-dessus du cadre */}
          <div className="pointer-events-none absolute -top-5 left-1/2 h-5 w-px -translate-x-1/2 bg-pretto/70" />
          <div
            onMouseDown={startDrag('rotate')}
            className="absolute -top-8 left-1/2 flex h-5 w-5 -translate-x-1/2 cursor-grab items-center justify-center rounded-full bg-pretto text-[10px] text-white shadow-md ring-2 ring-white active:cursor-grabbing"
            title="Pivoter · maintiens Maj pour te caler par pas de 15°"
          >
            ↻
          </div>
          {a.rotation ? (
            <div className="pointer-events-none absolute -bottom-6 left-1/2 -translate-x-1/2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
              {Math.round(a.rotation)}°
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

interface DragHighlightProps {
  a: HighlightAnnotation
  pageW: number
  pageH: number
  isSelected: boolean
  onSelect: () => void
  onUpdate: (id: string, updates: Partial<Annotation>) => void
  onRemove: (id: string) => void
  onDuplicate: (id: string) => void
  onContextMenu: (x: number, y: number, id: string) => void
}

function DraggableHighlightAnnotation({
  a,
  pageW,
  pageH,
  isSelected,
  onSelect,
  onUpdate,
  onRemove,
  onDuplicate,
  onContextMenu
}: DragHighlightProps): JSX.Element {
  const dragging = useRef<{
    mode: 'move' | 'resize'
    startX: number
    startY: number
    base: { x: number; y: number; w: number; h: number }
  } | null>(null)

  function startDrag(mode: 'move' | 'resize') {
    return (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      onSelect()
      dragging.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        base: { ...a.rect }
      }
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return
        const dx = (ev.clientX - dragging.current.startX) / pageW
        const dy = (ev.clientY - dragging.current.startY) / pageH
        const base = dragging.current.base
        if (dragging.current.mode === 'move') {
          onUpdate(a.id, {
            rect: {
              x: Math.max(0, Math.min(1 - base.w, base.x + dx)),
              y: Math.max(0, Math.min(1 - base.h, base.y + dy)),
              w: base.w,
              h: base.h
            }
          } as Partial<Annotation>)
        } else {
          onUpdate(a.id, {
            rect: {
              x: base.x,
              y: base.y,
              w: Math.max(0.005, Math.min(1 - base.x, base.w + dx)),
              h: Math.max(0.005, Math.min(1 - base.y, base.h + dy))
            }
          } as Partial<Annotation>)
        }
      }
      const onUp = () => {
        dragging.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
  }

  return (
    <div
      className="absolute group"
      style={{
        left: a.rect.x * pageW,
        top: a.rect.y * pageH,
        width: a.rect.w * pageW,
        height: a.rect.h * pageH,
        // Surlignage AU-DESSUS du texte (10/14) pour rester visible meme par-dessus
        // un texte modifie avec fond opaque (transparence du highlight conservee).
        zIndex: isSelected ? 15 : 11,
        cursor: 'move',
        outline: isSelected ? '2px solid #0C806E' : 'none',
        outlineOffset: 0,
        transform: a.rotation ? `rotate(${-a.rotation}deg)` : undefined,
        transformOrigin: '50% 50%'
      }}
      onMouseDown={startDrag('move')}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
        onContextMenu(e.clientX, e.clientY, a.id)
      }}
      title="Glisse pour déplacer · ⌘C pour copier · Clic-droit pour menu"
    >
      <div
        className="absolute inset-0 pointer-events-none rounded-sm"
        style={{ backgroundColor: a.color, opacity: a.opacity ?? 0.35 }}
      />
      {isSelected && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDuplicate(a.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute -top-2 -right-9 w-6 h-6 bg-pretto text-white rounded-full text-xs flex items-center justify-center shadow-md ring-2 ring-white hover:scale-110 transition-transform"
            title="Dupliquer"
          >
            ⧉
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRemove(a.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full text-xs flex items-center justify-center shadow-md ring-2 ring-white hover:scale-110 transition-transform"
            title="Supprimer"
          >
            ✕
          </button>
          <div
            onMouseDown={startDrag('resize')}
            className="absolute -bottom-1 -right-1 w-3 h-3 bg-pretto rounded-sm cursor-nwse-resize"
            title="Redimensionner"
          />
        </>
      )}
    </div>
  )
}

interface DragEraserProps {
  a: EraserAnnotation
  pageW: number
  pageH: number
  isSelected: boolean
  onSelect: () => void
  onUpdate: (id: string, updates: Partial<Annotation>) => void
  onRemove: (id: string) => void
  onDuplicate: (id: string) => void
  onContextMenu: (x: number, y: number, id: string) => void
}

function DraggableEraserAnnotation({
  a,
  pageW,
  pageH,
  isSelected,
  onSelect,
  onUpdate,
  onRemove,
  onDuplicate,
  onContextMenu
}: DragEraserProps): JSX.Element {
  const dragging = useRef<{
    mode: 'move' | 'resize'
    startX: number
    startY: number
    base: { x: number; y: number; w: number; h: number }
  } | null>(null)
  const [hovered, setHovered] = useState(false)

  function startDrag(mode: 'move' | 'resize') {
    return (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      onSelect()
      dragging.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        base: { ...a.rect }
      }
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return
        const dx = (ev.clientX - dragging.current.startX) / pageW
        const dy = (ev.clientY - dragging.current.startY) / pageH
        const base = dragging.current.base
        if (dragging.current.mode === 'move') {
          onUpdate(a.id, {
            rect: {
              x: Math.max(0, Math.min(1 - base.w, base.x + dx)),
              y: Math.max(0, Math.min(1 - base.h, base.y + dy)),
              w: base.w,
              h: base.h
            }
          } as Partial<Annotation>)
        } else {
          onUpdate(a.id, {
            rect: {
              x: base.x,
              y: base.y,
              w: Math.max(0.005, Math.min(1 - base.x, base.w + dx)),
              h: Math.max(0.005, Math.min(1 - base.y, base.h + dy))
            }
          } as Partial<Annotation>)
        }
      }
      const onUp = () => {
        dragging.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
  }

  const rotated = a.rotation !== undefined && Math.abs(a.rotation) > 0.001
  const rotatedStyle = rotated
    ? {
        // (rect.x, rect.y) = baseline-left pivot ; box monte au-dessus
        transform: `rotate(${-a.rotation!}deg) translateY(-100%)`,
        transformOrigin: '0 100%'
      }
    : {}

  return (
    <div
      className="absolute group"
      style={{
        left: a.rect.x * pageW,
        top: a.rect.y * pageH,
        width: a.rect.w * pageW,
        height: a.rect.h * pageH,
        backgroundColor: a.color || '#FFFFFF',
        // Masque/eraser TOUJOURS sous le texte (10/14) pour ne jamais le recouvrir
        zIndex: isSelected ? 6 : 4,
        cursor: 'move',
        // Bord invisible par defaut : la zone effacée se confond avec le fond
        // pour ressembler à une vraie suppression. Le bord apparaît au survol
        // pour pouvoir la repositionner / supprimer / redimensionner.
        border: isSelected
          ? '2px solid #0C806E'
          : hovered
            ? '1px dashed rgba(12,128,110,0.6)'
            : '1px solid transparent',
        borderRadius: 1,
        ...rotatedStyle
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={startDrag('move')}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
        onContextMenu(e.clientX, e.clientY, a.id)
      }}
      title="Zone effacée · Glisse pour déplacer · Clic-droit pour menu"
    >
      {isSelected && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDuplicate(a.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute -top-2 -right-9 w-6 h-6 bg-pretto text-white rounded-full text-xs flex items-center justify-center shadow-md ring-2 ring-white hover:scale-110 transition-transform"
            title="Dupliquer"
          >
            ⧉
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRemove(a.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full text-xs flex items-center justify-center shadow-md ring-2 ring-white hover:scale-110 transition-transform"
            title="Supprimer"
          >
            ✕
          </button>
          <div
            onMouseDown={startDrag('resize')}
            className="absolute -bottom-1 -right-1 w-3 h-3 bg-pretto rounded-sm cursor-nwse-resize"
            title="Redimensionner"
          />
        </>
      )}
    </div>
  )
}
