import { useCallback, useEffect, useState } from 'react'
import Sidebar, { Tool } from './components/Sidebar'
import Toolbar from './components/Toolbar'
import ThumbnailStrip, { PageEntry } from './components/ThumbnailStrip'
import ThumbnailGrid from './components/ThumbnailGrid'
import PageViewer from './components/PageViewer'
import EmptyState from './components/EmptyState'
import OCRPanel from './components/OCRPanel'
import MirrorCompare from './components/MirrorCompare'
import MergeDialog from './components/dialogs/MergeDialog'
import SplitDialog from './components/dialogs/SplitDialog'
import ExtractDialog from './components/dialogs/ExtractDialog'
import SignatureDialog from './components/dialogs/SignatureDialog'
import RemoveTextDialog from './components/dialogs/RemoveTextDialog'
import { renderPagesToThumbnails } from './lib/pdfRender'
import { createBlankPdf } from './lib/blankPdf'
import { Annotation, applyAnnotationsToPdf } from './lib/annotations'
import { FormField, applyFormFieldsToPdf } from './lib/forms'
import { ocrOnZone } from './lib/searchable'
import { removeTextTargets } from './lib/contentTextRemoval'
import type { LoadedImage } from './lib/imageImport'
import type { TextHit } from './lib/textEdit'

export default function App(): JSX.Element {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  // Fichiers récents (chemins absolus) persistes en localStorage
  const [recentFiles, setRecentFiles] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('pdf100k:recent') || '[]')
      return Array.isArray(v) ? v.filter((p) => typeof p === 'string') : []
    } catch {
      return []
    }
  })
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null)
  const [pages, setPages] = useState<PageEntry[]>([])
  const [currentPage, setCurrentPage] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // Tool initial = vue page (surlignage) → quand on ouvre un PDF on tombe
  // directement sur la 1re page, pas sur la grille de reorganisation.
  const [tool, setTool] = useState<Tool>('annotate-highlight')
  const [scale, setScale] = useState(1.2)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [formFields, setFormFields] = useState<FormField[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<
    null | 'merge' | 'split' | 'extract' | 'signature' | 'removeText'
  >(null)

  // Options des outils
  const [highlightColor, setHighlightColor] = useState('#FFF200')
  const [highlightOpacity, setHighlightOpacity] = useState(0.35)
  const [highlightMode, setHighlightMode] = useState<'shape' | 'text'>('shape')
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [clipboardAnnotation, setClipboardAnnotation] = useState<Annotation | null>(null)
  const [ocrZoneActive, setOcrZoneActive] = useState(false)
  const [ocrZoneResult, setOcrZoneResult] = useState<string | null>(null)
  // Comptes miroir : overlay plein écran avec 2 relevés navigables et surlignables
  const [mirrorOpen, setMirrorOpen] = useState(false)
  // Drag-and-drop overlay
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [penColor, setPenColor] = useState('#1A1A1A')
  const [penWidth, setPenWidth] = useState(3)
  const [textSize, setTextSize] = useState(14)
  const [textColor, setTextColor] = useState('#1A1A1A')
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null)
  // Image choisie dans l'outil « Image », en attente d'etre posee sur une page.
  // Elle reste en memoire apres la pose : on peut en placer plusieurs d'affilee.
  const [pendingImage, setPendingImage] = useState<LoadedImage | null>(null)

  // Ajoute un chemin en tête des récents (dédupe, max 10), persiste en localStorage
  const addRecent = useCallback((path: string) => {
    if (!path || path.startsWith('nouveau')) return
    setRecentFiles((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 10)
      try {
        localStorage.setItem('pdf100k:recent', JSON.stringify(next))
      } catch {
        /* quota plein : on ignore */
      }
      return next
    })
  }, [])

  const removeRecent = useCallback((path: string) => {
    setRecentFiles((prev) => {
      const next = prev.filter((p) => p !== path)
      try {
        localStorage.setItem('pdf100k:recent', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const clearRecent = useCallback(() => {
    setRecentFiles([])
    try {
      localStorage.removeItem('pdf100k:recent')
    } catch {
      /* ignore */
    }
  }, [])

  const loadFromPath = useCallback(
    async (path: string) => {
      setBusy(true)
      try {
        const buf = await window.api.readPdf(path)
        const thumbs = await renderPagesToThumbnails(buf)
        setFilePath(path)
        setPdfBytes(buf)
        setPages(thumbs)
        setCurrentPage(0)
        setSelected(new Set([0]))
        setAnnotations([])
        setFormFields([])
        setDirty(false)
        // A chaque ouverture : direct sur la 1re page (et pas la grille "Pages")
        setTool((t) => (t === 'pages' ? 'annotate-highlight' : t))
        addRecent(path)
      } finally {
        setBusy(false)
      }
    },
    [addRecent]
  )

  // Nouveau projet : PDF vierge A4, document non enregistré (pas de chemin)
  const newDocument = useCallback(async () => {
    setBusy(true)
    try {
      const buf = await createBlankPdf()
      const thumbs = await renderPagesToThumbnails(buf)
      setPdfBytes(buf)
      setPages(thumbs)
      setCurrentPage(0)
      setSelected(new Set([0]))
      setAnnotations([])
      setFormFields([])
      setFilePath(null)
      setDirty(true)
      setTool((t) => (t === 'pages' ? 'annotate-highlight' : t))
    } finally {
      setBusy(false)
    }
  }, [])

  // Ouvre un fichier récent ; s'il a disparu, le retire de la liste
  const openRecent = useCallback(
    async (path: string) => {
      try {
        await loadFromPath(path)
      } catch {
        window.alert(
          'Ce fichier est introuvable (déplacé, renommé ou supprimé).\nIl a été retiré des récents.'
        )
        removeRecent(path)
      }
    },
    [loadFromPath, removeRecent]
  )

  const loadFromBytes = useCallback(
    async (buf: ArrayBuffer, newName?: string) => {
      setBusy(true)
      try {
        const thumbs = await renderPagesToThumbnails(buf)
        setPdfBytes(buf)
        setPages(thumbs)
        setCurrentPage(0)
        setSelected(new Set([0]))
        setAnnotations([])
        setFormFields([])
        setDirty(true)
        if (newName) {
          // newName n'est passe que pour un nouveau document (drag-drop, fusion…)
          // → on bascule sur la 1re page. Pour les operations de reorganisation
          // (rotate/delete/reorder), newName est absent et on reste en mode Pages.
          setFilePath(newName)
          setTool((t) => (t === 'pages' ? 'annotate-highlight' : t))
        }
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const openFile = useCallback(async () => {
    const paths = await window.api.openPdf(false)
    if (!paths || paths.length === 0) return
    await loadFromPath(paths[0])
  }, [loadFromPath])

  // Écoute les fichiers passés par "Ouvrir avec" (Mac open-file event / Windows argv)
  useEffect(() => {
    const cleanup = window.api.onFileOpenRequest((path) => {
      loadFromPath(path).catch(() => {
        /* silencieux : si le fichier n'est pas un PDF valide */
      })
    })
    return cleanup
  }, [loadFromPath])

  // Drag-and-drop fichiers sur la fenetre : PDF / JPG / PNG
  useEffect(() => {
    let dragCounter = 0

    const isImagePath = (p: string): boolean => {
      const lower = p.toLowerCase()
      return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')
    }
    const isPdfPath = (p: string): boolean => p.toLowerCase().endsWith('.pdf')

    const onDragEnter = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      dragCounter++
      setIsDraggingFiles(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      dragCounter--
      if (dragCounter <= 0) {
        dragCounter = 0
        setIsDraggingFiles(false)
      }
    }
    const onDrop = async (e: DragEvent): Promise<void> => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      dragCounter = 0
      setIsDraggingFiles(false)

      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return

      // Recupere les paths via webUtils
      const paths = files
        .map((f) => window.api.getPathForFile(f))
        .filter((p) => isPdfPath(p) || isImagePath(p))

      if (paths.length === 0) {
        window.alert(
          'Aucun fichier PDF, JPG ou PNG trouvé. Glisse uniquement ces formats.'
        )
        return
      }

      setBusy(true)
      try {
        if (!pdfBytes) {
          // Pas de document ouvert : le 1er fichier devient le doc principal
          const first = paths[0]
          const firstBytes = isImagePath(first)
            ? await window.api.imageToPdfBytes(first)
            : await window.api.readPdf(first)
          // Charge le 1er
          // Garde le chemin complet : permet "Enregistrer" (remplace l'original)
          await loadFromBytes(firstBytes, first)

          // Ajoute les autres a la suite si plusieurs
          if (paths.length > 1) {
            let out = firstBytes
            let insertAt = 1
            for (let i = 1; i < paths.length; i++) {
              const p = paths[i]
              const buf = isImagePath(p)
                ? await window.api.imageToPdfBytes(p)
                : await window.api.readPdf(p)
              out = await window.api.pdfInsert(out, buf, insertAt)
              insertAt += 1
            }
            await loadFromBytes(out)
          }
        } else {
          // Document deja ouvert : append tous les fichiers a la suite
          let out = pdfBytes
          let insertAt = pages.length
          for (const p of paths) {
            const buf = isImagePath(p)
              ? await window.api.imageToPdfBytes(p)
              : await window.api.readPdf(p)
            out = await window.api.pdfInsert(out, buf, insertAt)
            insertAt += 1
          }
          await loadFromBytes(out)
        }
      } catch (err) {
        window.alert(
          'Erreur lors de l\'ajout du fichier : ' +
            (err instanceof Error ? err.message : String(err))
        )
      } finally {
        setBusy(false)
      }
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [pdfBytes, pages.length, loadFromBytes])

  // Comptes miroir : ouvre l'overlay de comparaison côte à côte
  const openMirror = useCallback(() => setMirrorOpen(true), [])
  const closeMirror = useCallback(() => setMirrorOpen(false), [])

  const buildFinalPdf = useCallback(async (): Promise<ArrayBuffer | null> => {
    if (!pdfBytes) return null
    let out = pdfBytes
    if (annotations.length > 0) {
      out = await applyAnnotationsToPdf(out, annotations)
    }
    if (formFields.length > 0) {
      out = await applyFormFieldsToPdf(out, formFields)
    }
    return out
  }, [pdfBytes, annotations, formFields])

  const save = useCallback(async () => {
    if (!pdfBytes) return
    let path = filePath
    const final = await buildFinalPdf()
    if (!final) return
    if (!path) {
      path = await window.api.savePdf('document.pdf')
      if (!path) return
    }
    await window.api.writePdf(path, final)
    setFilePath(path)
    setDirty(false)
    setAnnotations([])
    setFormFields([])
    setPdfBytes(final)
    setLastSavedAt(Date.now())
    addRecent(path)
  }, [pdfBytes, filePath, buildFinalPdf, addRecent])

  const saveAs = useCallback(async () => {
    if (!pdfBytes) return
    const final = await buildFinalPdf()
    if (!final) return
    const path = await window.api.savePdf(filePath?.split('/').pop() || 'document.pdf')
    if (!path) return
    await window.api.writePdf(path, final)
    setFilePath(path)
    setDirty(false)
    setAnnotations([])
    setFormFields([])
    setPdfBytes(final)
    setLastSavedAt(Date.now())
    addRecent(path)
  }, [pdfBytes, filePath, buildFinalPdf, addRecent])

  // Confirmation "Enregistré dans X" : s'efface auto apres 8s
  useEffect(() => {
    if (lastSavedAt === null) return
    const t = setTimeout(() => setLastSavedAt(null), 8000)
    return () => clearTimeout(t)
  }, [lastSavedAt])

  const addAnnotation = useCallback((a: Annotation) => {
    setAnnotations((prev) => [...prev, a])
    setDirty(true)
  }, [])

  const updateAnnotation = useCallback(
    (id: string, updates: Partial<Annotation>) => {
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? ({ ...a, ...updates } as Annotation) : a))
      )
      setDirty(true)
    },
    []
  )

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id))
    setDirty(true)
  }, [])

  const copyAnnotationById = useCallback(
    (id: string) => {
      const a = annotations.find((x) => x.id === id)
      if (a) setClipboardAnnotation(a)
    },
    [annotations]
  )

  const cutAnnotationById = useCallback(
    (id: string) => {
      const a = annotations.find((x) => x.id === id)
      if (a) {
        setClipboardAnnotation(a)
        setAnnotations((prev) => prev.filter((x) => x.id !== id))
        setSelectedAnnotationId(null)
        setDirty(true)
      }
    },
    [annotations]
  )

  const pasteAnnotation = useCallback(
    (clip: Annotation, atPage: number) => {
      const dx = 0.025
      const dy = 0.02
      const fresh = 'a_' + Math.random().toString(36).slice(2, 9)
      let copy: Annotation
      if (clip.kind === 'highlight') {
        copy = {
          ...clip,
          id: fresh,
          pageIndex: atPage,
          rect: {
            x: Math.min(1 - clip.rect.w, Math.max(0, clip.rect.x + dx)),
            y: Math.min(1 - clip.rect.h, Math.max(0, clip.rect.y + dy)),
            w: clip.rect.w,
            h: clip.rect.h
          }
        }
      } else if (clip.kind === 'text') {
        copy = {
          ...clip,
          id: fresh,
          pageIndex: atPage,
          x: Math.min(1, Math.max(0, clip.x + dx)),
          y: Math.min(1, Math.max(0, clip.y + dy))
        }
      } else if (clip.kind === 'image') {
        copy = {
          ...clip,
          id: fresh,
          pageIndex: atPage,
          x: Math.min(1 - clip.w, Math.max(0, clip.x + dx)),
          y: Math.min(1 - clip.h, Math.max(0, clip.y + dy))
        }
      } else if (clip.kind === 'eraser') {
        copy = {
          ...clip,
          id: fresh,
          pageIndex: atPage,
          rect: {
            x: Math.min(1 - clip.rect.w, Math.max(0, clip.rect.x + dx)),
            y: Math.min(1 - clip.rect.h, Math.max(0, clip.rect.y + dy)),
            w: clip.rect.w,
            h: clip.rect.h
          }
        }
      } else {
        copy = {
          ...clip,
          id: fresh,
          pageIndex: atPage,
          points: clip.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
        }
      }
      setAnnotations((prev) => [...prev, copy])
      setSelectedAnnotationId(copy.id)
      setDirty(true)
    },
    []
  )

  const pasteAtCurrent = useCallback(() => {
    if (clipboardAnnotation) pasteAnnotation(clipboardAnnotation, currentPage)
  }, [clipboardAnnotation, currentPage, pasteAnnotation])

  const rotateAnnotationById = useCallback((id: string, deltaDeg: number) => {
    setAnnotations((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a
        if (
          a.kind === 'text' ||
          a.kind === 'eraser' ||
          a.kind === 'image' ||
          a.kind === 'highlight'
        ) {
          const newRot = (((a.rotation || 0) + deltaDeg) % 360 + 360) % 360
          return { ...a, rotation: newRot === 0 ? undefined : newRot } as Annotation
        }
        return a
      })
    )
    setDirty(true)
  }, [])

  const duplicateAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => {
      const orig = prev.find((a) => a.id === id)
      if (!orig) return prev
      const dx = 0.025
      const dy = 0.02
      let copy: Annotation
      if (orig.kind === 'highlight') {
        copy = {
          ...orig,
          id: 'a_' + Math.random().toString(36).slice(2, 9),
          rect: {
            x: Math.min(1 - orig.rect.w, orig.rect.x + dx),
            y: Math.min(1 - orig.rect.h, orig.rect.y + dy),
            w: orig.rect.w,
            h: orig.rect.h
          }
        }
      } else if (orig.kind === 'text') {
        copy = {
          ...orig,
          id: 'a_' + Math.random().toString(36).slice(2, 9),
          x: Math.min(1, orig.x + dx),
          y: Math.min(1, orig.y + dy)
        }
      } else if (orig.kind === 'image') {
        copy = {
          ...orig,
          id: 'a_' + Math.random().toString(36).slice(2, 9),
          x: Math.min(1 - orig.w, orig.x + dx),
          y: Math.min(1 - orig.h, orig.y + dy)
        }
      } else if (orig.kind === 'eraser') {
        copy = {
          ...orig,
          id: 'a_' + Math.random().toString(36).slice(2, 9),
          rect: {
            x: Math.min(1 - orig.rect.w, orig.rect.x + dx),
            y: Math.min(1 - orig.rect.h, orig.rect.y + dy),
            w: orig.rect.w,
            h: orig.rect.h
          }
        }
      } else {
        copy = {
          ...orig,
          id: 'a_' + Math.random().toString(36).slice(2, 9),
          points: orig.points.map((p) => ({
            x: Math.min(1, p.x + dx),
            y: Math.min(1, p.y + dy)
          }))
        }
      }
      return [...prev, copy]
    })
    setDirty(true)
  }, [])

  const addFormField = useCallback((f: FormField) => {
    setFormFields((prev) => [...prev, f])
    setDirty(true)
  }, [])

  const removeFormField = useCallback((id: string) => {
    setFormFields((prev) => prev.filter((f) => f.id !== id))
    setDirty(true)
  }, [])

  const undoAnnotation = useCallback(() => {
    if (formFields.length > 0) {
      setFormFields((prev) => prev.slice(0, -1))
    } else {
      setAnnotations((prev) => prev.slice(0, -1))
    }
  }, [formFields.length])

  const onSearchableReady = useCallback(async (newBytes: ArrayBuffer) => {
    await loadFromBytes(newBytes)
  }, [loadFromBytes])

  const handleOcrZone = useCallback(
    async (pageIdx: number, rect: { x: number; y: number; w: number; h: number }) => {
      if (!pdfBytes) return
      setBusy(true)
      try {
        const text = await ocrOnZone(pdfBytes, pageIdx, rect)
        setOcrZoneResult(text)
        setOcrZoneActive(false)
      } finally {
        setBusy(false)
      }
    },
    [pdfBytes]
  )

  /**
   * Remplace le PDF en memoire APRES une modification de son contenu, sans
   * casser le travail en cours : on garde les annotations posees, la page
   * affichee et la selection. (loadFromBytes, lui, repart de zero.)
   */
  const replaceBytesKeepingState = useCallback(async (buf: ArrayBuffer) => {
    const thumbs = await renderPagesToThumbnails(buf)
    setPdfBytes(buf)
    setPages(thumbs)
    setDirty(true)
  }, [])

  const addEditableAnnotations = useCallback((newAnnots: Annotation[]) => {
    setAnnotations((prev) => [...prev, ...newAnnots])
    setDirty(true)
  }, [])

  const handleCommitModifyText = useCallback(
    async (
      pageIdx: number,
      hit: TextHit,
      newText: string,
      colors?: { background: string; text: string }
    ) => {
      const isRotated = Math.abs(hit.rotation) > 0.5

      // --- 1) On essaie d'abord de retirer VRAIMENT le texte du PDF ---
      // Si l'operateur qui le dessine peut sauter sans emporter de texte voisin,
      // on le supprime : plus de rectangle blanc, le fond d'origine (tableau,
      // trame, image) reste visible tel quel.
      if (pdfBytes && hit.rawTransform) {
        try {
          const r = await removeTextTargets(pdfBytes, [
            { pageIndex: pageIdx, transform: hit.rawTransform, str: hit.text }
          ])
          if (r.removed > 0) {
            await replaceBytesKeepingState(r.bytes)
            if (newText.trim() === '') return // efface : rien a redessiner
            setAnnotations((prev) => [
              ...prev,
              {
                id: 'a_' + Math.random().toString(36).slice(2, 9),
                kind: 'text',
                pageIndex: pageIdx,
                x: hit.baselineX,
                y: hit.baselineY,
                text: newText,
                size: hit.fontSize,
                color: colors?.text ?? '#000000',
                fontFamily: hit.fontFamily,
                bold: hit.bold,
                italic: hit.italic,
                rotation: isRotated ? hit.rotation : 0
              }
            ])
            setDirty(true)
            return
          }
        } catch {
          // Suppression impossible (PDF chiffre, flux exotique…) : on retombe
          // sur le masque, comme avant.
        }
      }

      // --- 2) Repli : masque couleur-fond par-dessus le texte ---
      const idEraser = 'a_' + Math.random().toString(36).slice(2, 9)
      const idNew = 'a_' + Math.random().toString(36).slice(2, 9)

      // Couleurs reelles echantillonnees sur l'original (fond + texte). Fallback
      // blanc/noir si l'echantillonnage a echoue.
      const bgColor = colors?.background ?? '#FFFFFF'
      const textColor = colors?.text ?? '#000000'

      // Largeur du nouveau texte estimee depuis la largeur moyenne/caractere de
      // l'original, +20% de marge (caracteres larges W, M…).
      const origLen = Math.max(1, hit.text.length)
      const avgCharW = hit.textWidth / origLen
      const estimatedNewWidth = newText.length * avgCharW * 1.2
      const effectiveWidth = Math.max(hit.textWidth, estimatedNewWidth)

      // pdfjs renvoie `textHeight`/`height` ≈ hauteur ascender (de la baseline au haut),
      // SANS les jambages. On etend le masque vers le haut (ascExtra) et surtout vers
      // le bas (descExtra) pour couvrir g/p/q/j/y/€ du nouveau texte ET de l'ancien.
      const ascExtra = hit.textHeight * 0.18
      const descExtra = hit.textHeight * 0.32
      const padX = Math.max(0.0015, hit.textWidth * 0.02)
      const padY = Math.max(0.001, hit.height * 0.1)

      // Effacement pur (texte vidé) → masque couleur-fond seul, pas de texte.
      if (newText.trim() === '') {
        const eraser: Annotation = isRotated
          ? {
              id: idEraser,
              kind: 'eraser',
              pageIndex: pageIdx,
              rect: {
                x: hit.baselineX,
                y: hit.baselineY,
                w: hit.textWidth + padX,
                h: hit.textHeight + ascExtra
              },
              color: bgColor,
              rotation: hit.rotation
            }
          : {
              id: idEraser,
              kind: 'eraser',
              pageIndex: pageIdx,
              rect: {
                x: Math.max(0, hit.x - padX),
                y: Math.max(0, hit.y - padY),
                w: hit.width + 2 * padX,
                h: hit.height + 2 * padY + descExtra
              },
              color: bgColor
            }
        setAnnotations((prev) => [...prev, eraser])
        setDirty(true)
        return
      }

      // Remplacement : UNE seule annotation `text` avec fond opaque intégré (masque +
      // texte solidaires, aucun problème de z-index, aucune annotation ne peut
      // s'intercaler). Texte toujours ancré sur la BASELINE d'origine (rotation 0
      // pour l'horizontal) → position verticale exacte dans le PDF.
      // - horizontal : backgroundRect en convention top-left (couvre ascender +
      //   descender) ; le PDF/preview dessinent le fond en top-left (rotation 0).
      // - rotaté : backgroundRect en convention pivot (baseline-left), monte vers le haut.
      const backgroundRect = isRotated
        ? {
            x: hit.baselineX,
            y: hit.baselineY,
            w: effectiveWidth + padX,
            h: hit.textHeight + ascExtra + descExtra
          }
        : {
            x: Math.max(0, hit.x - padX),
            y: Math.max(0, hit.y - padY),
            w: Math.max(hit.width, effectiveWidth) + 2 * padX,
            h: hit.height + 2 * padY + descExtra
          }

      const replacement: Annotation = {
        id: idNew,
        kind: 'text',
        pageIndex: pageIdx,
        x: hit.baselineX,
        y: hit.baselineY,
        text: newText,
        size: hit.fontSize,
        color: textColor,
        fontFamily: hit.fontFamily,
        bold: hit.bold,
        italic: hit.italic,
        rotation: isRotated ? hit.rotation : 0,
        background: bgColor,
        backgroundRect
      }
      setAnnotations((prev) => [...prev, replacement])
      setDirty(true)
    },
    [pdfBytes, replaceBytesKeepingState]
  )

  const rotatePages = useCallback(
    async (angle: 0 | 90 | 180 | 270, indices?: number[]) => {
      if (!pdfBytes) return
      const targets = indices ?? Array.from(selected)
      if (targets.length === 0) return
      const ops = pages.map((p, i) => ({
        srcIndex: p.srcIndex,
        rotate: (targets.includes(i) ? angle : 0) as 0 | 90 | 180 | 270
      }))
      setBusy(true)
      try {
        const out = await window.api.pdfReorder(pdfBytes, ops)
        await loadFromBytes(out)
      } finally {
        setBusy(false)
      }
    },
    [pdfBytes, pages, selected, loadFromBytes]
  )

  const deletePages = useCallback(
    async (indices?: number[]) => {
      if (!pdfBytes) return
      const targets = indices ?? Array.from(selected)
      if (targets.length === 0) return
      const kept = pages
        .map((p, i) => ({ p, i }))
        .filter(({ i }) => !targets.includes(i))
        .map(({ p }) => ({ srcIndex: p.srcIndex, rotate: 0 as const }))
      if (kept.length === 0) {
        window.alert(
          `Impossible de supprimer toutes les ${pages.length} pages.\n\n` +
            `Un PDF doit contenir au moins une page. Désélectionne au moins une page ` +
            `(⌘+clic dessus pour la retirer de la sélection) puis réessaie.\n\n` +
            `Si tu veux fermer le document, utilise plutôt "Ouvrir" pour en charger un autre.`
        )
        return
      }
      setBusy(true)
      try {
        const out = await window.api.pdfReorder(pdfBytes, kept)
        await loadFromBytes(out)
      } finally {
        setBusy(false)
      }
    },
    [pdfBytes, pages, selected, loadFromBytes]
  )

  const reorderPages = useCallback(
    async (newOrder: number[]) => {
      if (!pdfBytes) return
      const ops = newOrder.map((i) => ({ srcIndex: pages[i].srcIndex, rotate: 0 as const }))
      setBusy(true)
      try {
        const out = await window.api.pdfReorder(pdfBytes, ops)
        await loadFromBytes(out)
      } finally {
        setBusy(false)
      }
    },
    [pdfBytes, pages, loadFromBytes]
  )

  const insertFromFile = useCallback(
    async (atIndex: number) => {
      if (!pdfBytes) return
      const paths = await window.api.openPdf(false)
      if (!paths || paths.length === 0) return
      const insBuf = await window.api.readPdf(paths[0])
      setBusy(true)
      try {
        const out = await window.api.pdfInsert(pdfBytes, insBuf, atIndex)
        await loadFromBytes(out)
      } finally {
        setBusy(false)
      }
    },
    [pdfBytes, loadFromBytes]
  )

  // Insere a la position donnee plusieurs fichiers PDF ou images (JPG/PNG)
  // Les images sont automatiquement converties en page PDF A4.
  const appendPdfOrImages = useCallback(
    async (atIndex: number) => {
      if (!pdfBytes) return
      const paths = await window.api.openPdfOrImage(true)
      if (!paths || paths.length === 0) return
      setBusy(true)
      try {
        let out = pdfBytes
        let insertAt = atIndex
        for (const path of paths) {
          const lower = path.toLowerCase()
          const isImage =
            lower.endsWith('.jpg') ||
            lower.endsWith('.jpeg') ||
            lower.endsWith('.png')
          const insBuf = isImage
            ? await window.api.imageToPdfBytes(path)
            : await window.api.readPdf(path)
          out = await window.api.pdfInsert(out, insBuf, insertAt)
          // L'image/PDF a ajoute X pages, on incremente pour que le fichier
          // suivant s'insere apres
          // (approximation : on ne connaît pas exactement le nombre de pages
          // ajoutees ici, mais on peut juste continuer à la fin pour append)
          insertAt += 1
        }
        await loadFromBytes(out)
      } finally {
        setBusy(false)
      }
    },
    [pdfBytes, loadFromBytes]
  )

  function onContextAction(
    action: 'rotate-cw' | 'rotate-ccw' | 'delete' | 'insertAfter',
    indices: number[]
  ): void {
    if (indices.length === 0) return
    if (action === 'rotate-cw') rotatePages(90, indices)
    else if (action === 'rotate-ccw') rotatePages(270, indices)
    else if (action === 'delete') deletePages(indices)
    else if (action === 'insertAfter') insertFromFile(indices[0] + 1)
  }

  const onZoom = useCallback((delta: number | 'fit') => {
    if (delta === 'fit') {
      setScale(1.2)
      return
    }
    setScale((s) => Math.max(0.5, Math.min(3, +(s + delta).toFixed(2))))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      const inInput =
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA'
      if (meta && e.key === 'n' && !inInput) {
        e.preventDefault()
        newDocument()
      } else if (meta && e.key === 'o') {
        e.preventDefault()
        openFile()
      } else if (meta && e.key === 's') {
        e.preventDefault()
        if (e.shiftKey) saveAs()
        else save()
      } else if (meta && e.key === 'z' && !inInput) {
        e.preventDefault()
        if (annotations.length > 0 || formFields.length > 0) undoAnnotation()
      } else if (meta && e.key === 'c' && !inInput && selectedAnnotationId) {
        e.preventDefault()
        copyAnnotationById(selectedAnnotationId)
      } else if (meta && e.key === 'x' && !inInput && selectedAnnotationId) {
        e.preventDefault()
        cutAnnotationById(selectedAnnotationId)
      } else if (meta && e.key === 'v' && !inInput && clipboardAnnotation) {
        e.preventDefault()
        pasteAtCurrent()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput) {
        if (selectedAnnotationId) {
          e.preventDefault()
          removeAnnotation(selectedAnnotationId)
          setSelectedAnnotationId(null)
        } else if (tool === 'pages' && selected.size > 0) {
          e.preventDefault()
          const indices = Array.from(selected).sort((a, b) => a - b)
          deletePages(indices)
        }
      } else if (e.key === 'Escape') {
        setSelectedAnnotationId(null)
        setOcrZoneActive(false)
      } else if (meta && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        onZoom(0.25)
      } else if (meta && e.key === '-') {
        e.preventDefault()
        onZoom(-0.25)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    openFile,
    newDocument,
    save,
    saveAs,
    onZoom,
    undoAnnotation,
    annotations,
    formFields.length,
    selectedAnnotationId,
    clipboardAnnotation,
    currentPage,
    pasteAnnotation,
    pasteAtCurrent,
    copyAnnotationById,
    cutAnnotationById,
    removeAnnotation,
    tool,
    selected,
    deletePages
  ])

  return (
    <div className="h-screen w-screen flex flex-col bg-cream">
      <Toolbar
        filePath={filePath}
        dirty={dirty}
        busy={busy}
        hasDoc={!!pdfBytes}
        tool={tool}
        numPages={pages.length}
        currentPage={currentPage}
        scale={scale}
        highlightColor={highlightColor}
        highlightOpacity={highlightOpacity}
        highlightMode={highlightMode}
        penColor={penColor}
        penWidth={penWidth}
        textSize={textSize}
        textColor={textColor}
        signatureDataUrl={signatureDataUrl}
        onOpen={openFile}
        onNew={newDocument}
        recentFiles={recentFiles}
        onOpenRecent={openRecent}
        onClearRecent={clearRecent}
        onSave={save}
        onSaveAs={saveAs}
        onMerge={() => setDialog('merge')}
        onSplit={() => setDialog('split')}
        onExtract={() => setDialog('extract')}
        onOrganize={() => setTool((t) => (t === 'pages' ? 'annotate-highlight' : 'pages'))}
        organizeActive={tool === 'pages'}
        onZoom={onZoom}
        onSetHighlightColor={setHighlightColor}
        onSetHighlightOpacity={setHighlightOpacity}
        onSetHighlightMode={setHighlightMode}
        onSetPenColor={setPenColor}
        onSetPenWidth={setPenWidth}
        onSetTextSize={setTextSize}
        onSetTextColor={setTextColor}
        onCreateSignature={() => setDialog('signature')}
        onClearSignature={() => setSignatureDataUrl(null)}
        pendingImage={pendingImage}
        onImageChosen={setPendingImage}
        onClearImage={() => setPendingImage(null)}
        onOpenRemoveTextDialog={() => setDialog('removeText')}
        onUndo={undoAnnotation}
        hasAnnotations={annotations.length > 0 || formFields.length > 0}
        formFieldsCount={formFields.length}
        onOpenMirror={openMirror}
        onCloseMirror={closeMirror}
        mirrorActive={mirrorOpen}
        lastSavedAt={lastSavedAt}
      />
      <div className="flex flex-1 min-h-0">
        <Sidebar active={tool} onChange={setTool} hasDoc={!!pdfBytes} />
        {pdfBytes ? (
          tool === 'pages' ? (
            <main className="flex-1 min-w-0 overflow-hidden">
              <ThumbnailGrid
                pages={pages}
                currentPage={currentPage}
                selected={selected}
                onSelect={(i) => setCurrentPage(i)}
                onOpenPage={(i) => {
                  setCurrentPage(i)
                  setTool('annotate-highlight')
                }}
                onSelectionChange={setSelected}
                onReorder={reorderPages}
                onContextAction={onContextAction}
                onAppendPdf={() => appendPdfOrImages(pages.length)}
              />
            </main>
          ) : (
            <>
              <ThumbnailStrip
                pages={pages}
                currentPage={currentPage}
                selected={selected}
                onSelect={(i) => setCurrentPage(i)}
                onSelectionChange={setSelected}
                onReorder={reorderPages}
                onContextAction={onContextAction}
              />
              <main className="flex-1 min-w-0 overflow-hidden">
                <PageViewer
                  pdfBytes={pdfBytes}
                  numPages={pages.length}
                  currentPage={currentPage}
                  setCurrentPage={setCurrentPage}
                  setZoom={onZoom}
                  scale={scale}
                  tool={tool}
                  annotations={annotations}
                  onAddAnnotation={addAnnotation}
                  onUpdateAnnotation={updateAnnotation}
                  onRemoveAnnotation={removeAnnotation}
                  onDuplicateAnnotation={duplicateAnnotation}
                  onCopyAnnotation={copyAnnotationById}
                  onCutAnnotation={cutAnnotationById}
                  onPasteAnnotation={pasteAtCurrent}
                  canPasteAnnotation={clipboardAnnotation !== null}
                  onCommitModifyText={handleCommitModifyText}
                  onRotateAnnotation={rotateAnnotationById}
                  formFields={formFields}
                  onAddFormField={addFormField}
                  onRemoveFormField={removeFormField}
                  highlightColor={highlightColor}
                  highlightOpacity={highlightOpacity}
                  highlightMode={highlightMode}
                  onSetTextSize={setTextSize}
                  selectedAnnotationId={selectedAnnotationId}
                  onSelectAnnotation={setSelectedAnnotationId}
                  ocrZoneActive={ocrZoneActive}
                  onOcrZone={handleOcrZone}
                  penColor={penColor}
                  penWidth={penWidth}
                  textSize={textSize}
                  textColor={textColor}
                  signatureDataUrl={signatureDataUrl}
                  onPlaceSignature={() => {
                    /* signature reste en mémoire pour placement multiple */
                  }}
                  pendingImage={pendingImage}
                  onPlaceImage={() => {
                    /* l'image reste en mémoire : on peut en poser plusieurs */
                  }}
                />
              </main>
              {tool === 'ocr' && (
                <OCRPanel
                  pdfBytes={pdfBytes}
                  numPages={pages.length}
                  currentPage={currentPage}
                  ocrZoneActive={ocrZoneActive}
                  zoneResult={ocrZoneResult}
                  onSearchableReady={onSearchableReady}
                  onToggleZoneMode={() => {
                    setOcrZoneActive((v) => !v)
                    setOcrZoneResult(null)
                  }}
                  onAddEditableAnnotations={addEditableAnnotations}
                  onClearZoneResult={() => setOcrZoneResult(null)}
                />
              )}
            </>
          )
        ) : (
          <main className="flex-1 min-w-0 overflow-hidden">
            <EmptyState
              onOpen={openFile}
              onNew={newDocument}
              onMerge={() => setDialog('merge')}
              recentFiles={recentFiles}
              onOpenRecent={openRecent}
            />
          </main>
        )}
      </div>

      {dialog === 'merge' && (
        <MergeDialog
          onClose={() => setDialog(null)}
          onDone={async (bytes) => {
            await loadFromBytes(bytes, 'fusion.pdf')
            setDialog(null)
          }}
        />
      )}
      {dialog === 'split' && pdfBytes && (
        <SplitDialog
          totalPages={pages.length}
          pdfBytes={pdfBytes}
          onClose={() => setDialog(null)}
          onDone={() => setDialog(null)}
        />
      )}
      {dialog === 'extract' && pdfBytes && (
        <ExtractDialog
          totalPages={pages.length}
          pdfBytes={pdfBytes}
          selected={selected}
          onClose={() => setDialog(null)}
          onDone={() => setDialog(null)}
        />
      )}
      {dialog === 'signature' && (
        <SignatureDialog
          onClose={() => setDialog(null)}
          onDone={(d) => {
            setSignatureDataUrl(d)
            setDialog(null)
          }}
        />
      )}
      {dialog === 'removeText' && pdfBytes && (
        <RemoveTextDialog
          pdfBytes={pdfBytes}
          onClose={() => setDialog(null)}
          onDone={async (newBytes, removedCount) => {
            setDialog(null)
            await loadFromBytes(newBytes)
            window.alert(
              `${removedCount} occurrence${removedCount > 1 ? 's' : ''} effacée${removedCount > 1 ? 's' : ''}.\n\n` +
                `Pense à enregistrer (⌘S) pour graver la modification dans le PDF.`
            )
          }}
        />
      )}

      {/* Comptes miroir : overlay plein écran de comparaison côte à côte */}
      {mirrorOpen && (
        <MirrorCompare
          mainBytes={pdfBytes}
          mainName={filePath ? filePath.split('/').pop() || null : null}
          onClose={closeMirror}
        />
      )}

      {/* Overlay drag-and-drop : visible quand on glisse des fichiers sur la fenetre */}
      {isDraggingFiles && (
        <div className="fixed inset-0 z-[1000] bg-pretto/15 backdrop-blur-[2px] pointer-events-none flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl px-10 py-8 border-4 border-dashed border-pretto flex flex-col items-center gap-2">
            <div className="text-5xl mb-1">📥</div>
            <div className="text-xl font-semibold text-pretto">
              {pdfBytes ? 'Ajouter à la suite du document' : 'Ouvrir ce fichier'}
            </div>
            <div className="text-sm text-black/60">PDF · JPG · PNG (multi-fichiers OK)</div>
          </div>
        </div>
      )}
    </div>
  )
}
