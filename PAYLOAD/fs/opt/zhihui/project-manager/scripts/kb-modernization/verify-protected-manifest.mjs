import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const manifestPath='docs/evidence/kb-modernization/G6/weixin-protected-manifest.sha256'
const lines=(await readFile(manifestPath,'utf8')).trim().split('\n').filter(Boolean)
if(!lines.length)throw new Error('protected_manifest_empty')
const paths=lines.map(line=>line.slice(66))
const requiredFiles=['/home/lgsj/harness/weixin-account-manager/server.mjs','/home/lgsj/harness/weixin-account-manager/package.json','/home/lgsj/.dsh/dsh-channels/runtime-agent-routes.json']
const requiredDirectories=['/scripts/','/migration/','/data/','/contracts/','/storage/']
for(const path of requiredFiles)if(!paths.includes(path))throw new Error(`protected_required_file_missing:${path}`)
for(const segment of requiredDirectories)if(!paths.some(path=>path.startsWith('/home/lgsj/harness/weixin-account-manager/')&&path.includes(segment)))throw new Error(`protected_category_missing:${segment}`)
for(const line of lines){
  const match=/^([0-9a-f]{64})  (\/.*)$/.exec(line)
  if(!match)throw new Error('protected_manifest_format_invalid')
  const [,expected,path]=match
  if(!existsSync(path))throw new Error(`protected_path_missing:${path}`)
  const hash=createHash('sha256')
  await new Promise((resolve,reject)=>createReadStream(path).on('data',chunk=>hash.update(chunk)).on('end',resolve).on('error',reject))
  if(hash.digest('hex')!==expected)throw new Error(`protected_path_changed:${path}`)
}
console.log(JSON.stringify({ok:true,files:lines.length,categories:{server:true,package:true,scripts:true,migration:true,data:true,contracts:true,storage:true,src:'absent-recorded',runtimeRoute:true},contentsExposed:false}))
