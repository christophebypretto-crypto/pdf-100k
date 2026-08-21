// Signature ad-hoc de l'app macOS, appliquée juste après le packaging et avant
// la fabrication du .dmg / .zip.
//
// POURQUOI : `mac.identity: null` désactive complètement la signature dans
// electron-builder. Le bundle ne garde alors que la signature « linker-signed »
// posée par le compilateur, sans _CodeSignature/CodeResources — et `codesign
// --verify` échoue sur « code has no resources but signature indicates they
// must be present ». Résultat pour l'utilisateur : dès que le fichier passe par
// un navigateur (donc mis en quarantaine), macOS affiche
// « PDF 100K est endommagé et ne peut pas être ouvert » — un mur, sans
// contournement possible. C'est ce qui bloquait toute l'équipe.
//
// Avec une signature ad-hoc VALIDE, macOS se contente d'un
// « le développeur ne peut pas être vérifié », que l'on lève en deux clics dans
// Réglages Système. La vraie solution reste un certificat Developer ID + une
// notarisation ; en attendant, ceci rend l'app installable.
//
// ORDRE DE SIGNATURE : de l'intérieur vers l'extérieur, sinon les sceaux des
// composants internes sont invalidés. Les frameworks se signent sur
// `Versions/A`, jamais sur le lien symbolique `Versions/Current`.

const { execFileSync } = require('child_process')
const { readdirSync, existsSync } = require('fs')
const { join } = require('path')

function sign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'pipe' })
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const frameworks = join(appPath, 'Contents', 'Frameworks')

  // 1. bibliothèques natives
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.dylib') || entry.name.endsWith('.node')) sign(full)
    }
  }
  if (existsSync(frameworks)) walk(frameworks)

  // 2. processus d'assistance (Helper, Helper (GPU), Helper (Renderer)…)
  if (existsSync(frameworks)) {
    for (const entry of readdirSync(frameworks)) {
      if (entry.endsWith('.app')) sign(join(frameworks, entry))
    }
    // 3. frameworks — sur la version, pas sur le lien Current
    for (const entry of readdirSync(frameworks)) {
      if (!entry.endsWith('.framework')) continue
      const versionA = join(frameworks, entry, 'Versions', 'A')
      sign(existsSync(versionA) ? versionA : join(frameworks, entry))
    }
  }

  // 4. le bundle lui-même
  sign(appPath)

  // Garde-fou : un build qui repart avec une signature invalide reproduirait le
  // « est endommagé » chez tout le monde. Mieux vaut échouer ici.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' })
  console.log('  • signature ad-hoc appliquée et vérifiée')
}
