import type {FastifyInstance} from 'fastify'
import {legacyImportExecutionPolicy} from './import-route-policy.js'

export function registerLegacyImportExecuteRoute(app:FastifyInstance,deps:{readUpload:(request:any)=>Promise<{kind:string;fileName:string;body:Buffer}>;execute:(projectId:string,kind:string,fileName:string,body:Buffer)=>Promise<unknown>}){
 app.post<{Params:{projectId:string}}>('/api/projects/:projectId/imports/execute',async(request,reply)=>{try{const upload=await deps.readUpload(request),policy=legacyImportExecutionPolicy(request.params.projectId,upload.kind);if(policy.status===409)return reply.code(409).send(policy.body);return reply.code(201).send(await deps.execute(request.params.projectId,upload.kind,upload.fileName,upload.body))}catch(error){const code=error instanceof Error?error.message:'import_execute_failed';return reply.code(code==='project_not_found'?404:code==='import_format_unsupported'?415:400).send({error:code})}})
}
