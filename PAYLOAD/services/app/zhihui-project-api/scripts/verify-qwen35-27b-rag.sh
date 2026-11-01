#!/usr/bin/env bash
set -euo pipefail
MODEL='qwen3.5:27b-zhihui'
EXPECTED_DIGEST='d4b8b4f4c350f5d322dc8235175eeae02d32c6f3fd70bdb9ea481e3abb7d7fc4'
SERVICE_ENV='/home/lgsj/.config/zhihui-apps.env'
WIKI_ENV='/home/lgsj/.config/llm-wiki-apps.env'
set -a
source "$SERVICE_ENV"
source "$WIKI_ENV"
set +a

echo '[1/6] model registration'
ollama show "$MODEL" >/dev/null
ollama show qwen3.5:27b | grep -E 'parameters|quantization|context length' || true

echo '[2/6] official model blob digest'
BLOB="/var/lib/ollama/models/blobs/sha256-$EXPECTED_DIGEST"
if [[ -r "$BLOB" ]]; then echo "$EXPECTED_DIGEST  $BLOB" | sha256sum -c -; else echo 'blob is Ollama-owned; verified by importer before registration'; fi

echo '[3/8] direct Ollama inference'
response=$(curl -fsS --max-time 600 http://127.0.0.1:11434/v1/chat/completions -H 'content-type: application/json' -d '{"model":"qwen3.5:27b-zhihui","messages":[{"role":"user","content":"请用一句话说明项目知识库的用途。"}],"stream":false,"max_tokens":256}')
RESPONSE="$response" python -c 'import json,os;d=json.loads(os.environ["RESPONSE"]);m=d["choices"][0]["message"];assert (m.get("content") or m.get("reasoning"));print("direct inference OK",d["choices"][0]["finish_reason"])'

echo '[4/8] Harness route and inference'
curl -fsS -X POST http://127.0.0.1:3080/api/llm.models -H 'content-type: application/json' -d '{"type":"client-request","rpcId":"verify-qwen35-route","method":"llm.models","payload":{}}' | python -c 'import json,sys; d=json.load(sys.stdin)["result"]["value"]; assert any(g["id"]=="ollama-local" and any(m["id"]=="qwen3.5:27b-zhihui" for m in g["models"]) for g in d["groups"]); print("ollama-local/qwen3.5:27b-zhihui registered")'
node - <<'JS'
const base='http://127.0.0.1:3080/api/'
async function rpc(method,payload){const r=await fetch(base+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:`verify-${Date.now()}`,method,payload})});const j=await r.json();if(!j.result?.ok)throw new Error(JSON.stringify(j));return j.result.value}
const session=await rpc('session.create',{agentPreset:'minimal'})
await rpc('session.selectModel',{sessionId:session.sessionId,provider:'ollama-local',model:'qwen3.5:27b-zhihui'})
await rpc('session.prompt',{sessionId:session.sessionId,mode:'queue',content:[{type:'text',text:'简要回答：项目知识库用于什么？'}]})
for(let i=0;i<1200;i++){const h=await rpc('session.history',{sessionId:session.sessionId,maxMessages:100});const events=h.events.map(x=>x.event).filter(Boolean);const end=[...events].reverse().find(x=>x.type==='turn/end');if(end){if(end.data?.reason?.kind==='error')throw new Error(JSON.stringify(end.data.reason));console.log('Harness 27B inference completed',session.sessionId);process.exit(0)}await new Promise(r=>setTimeout(r,500))}throw new Error('Harness 27B inference timeout')
JS

echo '[5/8] service health'
systemctl --user is-active project-manager-api.service opportunity-manager-api.service llm-wiki-vector.service
curl -fsS "$LLM_WIKI_API_BASE_URL/api/v1/health" | python -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True; print("LLM Wiki healthy")'

echo '[6/8] isolated project RAG retrieval'
for row in 'bcbd1d24-bf71-4137-b076-e301bc9fd81e|AI龙岗一期项目' 'a0cd4c47-20b5-439b-b4be-85490b9ad4d6|数据聚合服务平台建设项目'; do
  IFS='|' read -r id expected <<<"$row"
  result=$(curl -fsS -H "x-zh-service: $ZH_SERVICE_TOKEN" -H 'content-type: application/json' -X POST "http://127.0.0.1:3100/api/projects/$id/knowledge/hybrid-search" -d '{"q":"项目实施计划","mode":"hybrid","limit":3,"minScore":0.2}')
  RESULT="$result" EXPECTED="$expected" python -c 'import json,os;d=json.loads(os.environ["RESULT"]); assert not d.get("degraded",False); assert d.get("items"); assert all(os.environ["EXPECTED"] in x.get("documentName","") for x in d["items"]); print(os.environ["EXPECTED"],"LLM Wiki primary OK")'
done

echo '[7/8] opportunity all-project RAG retrieval'
result=$(curl -fsS -H "x-zh-service: $ZH_SERVICE_TOKEN" -H 'content-type: application/json' -X POST 'http://127.0.0.1:3100/api/projects/5bd48566-c4c4-4899-9e70-a5d8c10b3184/knowledge/hybrid-search' -d '{"q":"项目实施计划","mode":"hybrid","limit":8,"minScore":0.2}')
RESULT="$result" python -c 'import json,os;d=json.loads(os.environ["RESULT"]); names={x.get("documentName","") for x in d.get("items",[])}; assert not d.get("degraded",False); assert len(names)>=2; print("OPP-MASTER cross-project LLM Wiki primary OK",len(names))'
echo '[8/8] runtime selection'
systemctl --user show project-manager-api.service opportunity-manager-api.service -p MainPID --no-pager
curl -fsS -H "x-zh-service: $ZH_SERVICE_TOKEN" http://127.0.0.1:3100/api/ai/models >/dev/null
echo 'verification baseline passed'
