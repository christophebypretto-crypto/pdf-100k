import { PDFDocument } from 'pdf-lib'

export type FormFieldKind = 'text' | 'checkbox'

export interface FormField {
  id: string
  kind: FormFieldKind
  pageIndex: number
  name: string
  // Coords normalisees [0,1] top-left
  x: number
  y: number
  w: number
  h: number
}

export function newFieldId(): string {
  return 'fld_' + Math.random().toString(36).slice(2, 9)
}

/** Applique les form fields a un PDF et renvoie un PDF avec AcroForm */
export async function applyFormFieldsToPdf(
  data: ArrayBuffer,
  fields: FormField[]
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(data, { ignoreEncryption: true })
  const form = doc.getForm()
  const pages = doc.getPages()

  for (const f of fields) {
    const page = pages[f.pageIndex]
    if (!page) continue
    // Origine + dimensions sur la CropBox, la boite que pdfjs affiche : une page
    // ne commence pas forcement en (0,0) (cf. lib/annotations.ts).
    const boite = page.getCropBox()
    const pw = boite.width
    const ph = boite.height
    const x = boite.x + f.x * pw
    const y = boite.y + ph - (f.y + f.h) * ph
    const w = f.w * pw
    const h = f.h * ph

    if (f.kind === 'text') {
      const field = form.createTextField(f.name)
      field.addToPage(page, { x, y, width: w, height: h, borderWidth: 0.5 })
    } else if (f.kind === 'checkbox') {
      const field = form.createCheckBox(f.name)
      field.addToPage(page, { x, y, width: w, height: h })
    }
  }

  const bytes = await doc.save()
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}
