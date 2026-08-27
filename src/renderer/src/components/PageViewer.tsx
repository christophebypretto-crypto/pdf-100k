import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
// @ts-ignore — Vite gere ?url
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import PageCanvas from './PageCanvas'
import { Annotation } from '../lib/annotations'
import { FormField } from '../lib/forms'
import { Tool } from './Sidebar'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

interface Props {
  pdfBytes: ArrayBuffer
  numPages: number
  currentPage: number
  setCurrentPage: (n: number) => void
  setZoom: (delta: number | 'fit') => void
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
    hit: import('../lib/textEdit').TextHit,
    newText: string
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
  onPlaceSignature: () => void
  pendingImage: import('../lib/imageImport').LoadedImage | null
  onPlaceImage: () => void
}

export default function PageViewer(p: Props): JSX.Element {
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<(HTMLDivElement | null)[]>([])
  // Flag pour ignorer le scroll listener pendant qu'on scroll programmatiquement
  const programmaticScrollUntil = useRef<number>(0)

  // Position de lecture a restaurer quand le PDF est rechargé en cours de route
  // (ex : suppression reelle d'un texte) — sinon on serait renvoye en haut du
  // document a chaque modification.
  const keepScroll = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const previous = keepScroll.current
    const copy = p.pdfBytes.slice(0)
    pdfjsLib.getDocument({ data: copy }).promise.then((d) => {
      if (cancelled) return
      setDoc(d)
      if (previous == null) return
      // deux frames : le temps que les pages soient montees et mesurees
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = previous
        })
      )
    })
    return () => {
      cancelled = true
      keepScroll.current = scrollRef.current?.scrollTop ?? null
      setDoc(null)
    }
  }, [p.pdfBytes])

  // Scroll vers la page courante quand elle change (via clic miniature par exemple)
  useEffect(() => {
    const root = scrollRef.current
    const el = pageRefs.current[p.currentPage]
    if (el && root) {
      // Geler le scroll listener pendant 800ms pour eviter la feedback loop
      programmaticScrollUntil.current = Date.now() + 800
      // scrollTop precis = position de la page dans le conteneur scrollable
      const targetTop = el.offsetTop - 24
      root.scrollTo({ top: targetTop, behavior: 'smooth' })
    }
  }, [p.currentPage])

  // Zoom au pinch trackpad ET ⌘/Ctrl + molette
  // Sur Mac : pinch trackpad envoie wheel events avec ctrlKey=true (convention Chromium)
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    let accumulated = 0
    let raf = 0
    const flush = () => {
      raf = 0
      if (accumulated === 0) return
      const delta = accumulated > 0 ? -0.1 : 0.1
      accumulated = 0
      p.setZoom(delta)
    }
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      accumulated += e.deltaY
      if (!raf) raf = requestAnimationFrame(flush)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      root.removeEventListener('wheel', onWheel)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [p.setZoom])

  // Detecte la page visible au scroll pour mettre a jour currentPage
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      if (Date.now() < programmaticScrollUntil.current) return
      const scrollTop = root.scrollTop + root.clientHeight / 3
      let best = 0
      let bestDist = Infinity
      for (let i = 0; i < p.numPages; i++) {
        const el = pageRefs.current[i]
        if (!el) continue
        const top = el.offsetTop
        const dist = Math.abs(top - scrollTop)
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      }
      if (best !== p.currentPage) p.setCurrentPage(best)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [p.numPages, p.currentPage, p.setCurrentPage])

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-auto bg-black/[0.03] py-8 px-6"
    >
      <div className="flex flex-col items-center gap-6">
        {Array.from({ length: p.numPages }).map((_, i) => (
          <div
            key={i}
            ref={(el) => (pageRefs.current[i] = el)}
            className="flex flex-col items-center gap-1"
          >
            <PageCanvas
              pdfDoc={doc}
              pageIndex={i}
              scale={p.scale}
              tool={p.tool}
              annotations={p.annotations}
              onAddAnnotation={p.onAddAnnotation}
              onUpdateAnnotation={p.onUpdateAnnotation}
              onRemoveAnnotation={p.onRemoveAnnotation}
              onDuplicateAnnotation={p.onDuplicateAnnotation}
              onCopyAnnotation={p.onCopyAnnotation}
              onCutAnnotation={p.onCutAnnotation}
              onPasteAnnotation={p.onPasteAnnotation}
              canPasteAnnotation={p.canPasteAnnotation}
              onCommitModifyText={p.onCommitModifyText}
              onRotateAnnotation={p.onRotateAnnotation}
              formFields={p.formFields}
              onAddFormField={p.onAddFormField}
              onRemoveFormField={p.onRemoveFormField}
              highlightColor={p.highlightColor}
              highlightOpacity={p.highlightOpacity}
              highlightMode={p.highlightMode}
              onSetTextSize={p.onSetTextSize}
              selectedAnnotationId={p.selectedAnnotationId}
              onSelectAnnotation={p.onSelectAnnotation}
              ocrZoneActive={p.ocrZoneActive}
              onOcrZone={p.onOcrZone}
              penColor={p.penColor}
              penWidth={p.penWidth}
              textSize={p.textSize}
              textColor={p.textColor}
              signatureDataUrl={p.signatureDataUrl}
              onPlaceSignature={p.onPlaceSignature}
              pendingImage={p.pendingImage}
              onPlaceImage={p.onPlaceImage}
              isCurrent={i === p.currentPage}
              onClick={() => p.setCurrentPage(i)}
            />
            <div className="text-xs text-black/40">Page {i + 1} / {p.numPages}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
