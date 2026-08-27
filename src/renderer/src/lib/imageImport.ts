/**
 * Import d'une image depuis le disque pour l'insérer dans un PDF.
 *
 * pdf-lib ne sait embarquer que du PNG et du JPEG. Tout autre format lisible par
 * le navigateur (WebP, GIF, BMP…) est donc re-encodé en PNG avant d'arriver dans
 * le document — sinon l'image serait acceptée à l'écran puis perdue au moment
 * d'enregistrer.
 */

export interface LoadedImage {
  /** dataURL PNG ou JPEG, prêt pour pdf-lib */
  dataUrl: string
  /** dimensions natives, pour poser l'image sans la déformer */
  width: number
  height: number
}

/** Formats que pdf-lib embarque directement, sans re-encodage. */
const NATIF = ['image/png', 'image/jpeg']

function lireEnDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Lecture du fichier impossible"))
    reader.readAsDataURL(file)
  })
}

function chargerImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () =>
      reject(new Error("Format d'image non reconnu. Utilise un PNG ou un JPEG."))
    img.src = src
  })
}

/** Re-encode en PNG via un canvas (formats non gérés nativement par pdf-lib). */
function versPng(img: HTMLImageElement): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error("Conversion de l'image impossible")
  ctx.drawImage(img, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * Lit un fichier image choisi par l'utilisateur et renvoie de quoi le poser sur
 * une page : un dataURL exploitable par pdf-lib et les dimensions natives.
 */
export async function loadImageFile(file: File): Promise<LoadedImage> {
  const brut = await lireEnDataUrl(file)
  const img = await chargerImage(brut)
  if (!img.naturalWidth || !img.naturalHeight) {
    throw new Error("Image vide ou illisible")
  }
  const dataUrl = NATIF.includes(file.type) ? brut : versPng(img)
  return { dataUrl, width: img.naturalWidth, height: img.naturalHeight }
}

/**
 * Taille de départ d'une image posée sur une page, en coordonnées normalisées.
 *
 * On vise une largeur confortable (40 % de la page) tout en gardant les
 * proportions d'origine, et on réduit si l'image dépasse en hauteur — une photo
 * en mode portrait ne doit pas déborder de la page.
 */
export function taillePose(
  image: LoadedImage,
  pageRatio: number
): { w: number; h: number } {
  // Les coordonnees sont normalisees SEPAREMENT en largeur et en hauteur : pour
  // que l'image garde ses proportions a l'ecran, il faut reintroduire le ratio
  // de la page.  largeur_physique / hauteur_physique = ratioImage
  //  => (w * pageW) / (h * pageH) = ratioImage
  //  => h = w * pageRatio / ratioImage      avec pageRatio = pageW / pageH
  const ratioImage = image.width / image.height
  let w = 0.4
  let h = (w * pageRatio) / ratioImage
  if (h > 0.5) {
    h = 0.5
    w = (h * ratioImage) / pageRatio
  }
  return { w, h }
}
