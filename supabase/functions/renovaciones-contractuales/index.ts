import { createClient } from "npm:@supabase/supabase-js@2";
import PizZip from "npm:pizzip";
import Docxtemplater from "npm:docxtemplater";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendKey = Deno.env.get("RESEND_API_KEY")!;
const appUrl = Deno.env.get("APP_URL")!;
const automationKey = Deno.env.get("AUTOMATION_KEY")!;
const from = Deno.env.get("EMAIL_FROM") || "Contratos Quick <contratos@quick.com.co>";
const sb = createClient(supabaseUrl, serviceKey);

const iso = (d: Date) => d.toISOString().slice(0,10);
const sumarMeses = (fecha:string, meses:number) => { const d=new Date(fecha+"T12:00:00Z"); d.setUTCMonth(d.getUTCMonth()+meses); return iso(d); };
const sumarDias = (fecha:string, dias:number) => { const d=new Date(fecha+"T12:00:00Z"); d.setUTCDate(d.getUTCDate()+dias); return iso(d); };
const fechaLarga = (f:string) => new Intl.DateTimeFormat("es-CO",{dateStyle:"long",timeZone:"UTC"}).format(new Date(f+"T12:00:00Z"));

async function enviar(to:string[],subject:string,html:string,attachment?:{path:string,filename:string}){
  const body:any={from,to:[...new Set(to)],subject,html};
  if(attachment) body.attachments=[attachment];
  const res=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${resendKey}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function generarDocumento(c:any,inicio:string,fin:string){
  if(!c.plantilla_path) throw new Error("El contrato no tiene plantilla DOCX");
  const {data,error}=await sb.storage.from("contratos").download(c.plantilla_path);
  if(error) throw error;
  const zip=new PizZip(await data.arrayBuffer());
  const doc=new Docxtemplater(zip,{paragraphLoop:true,linebreaks:true});
  doc.render({fecha_inicio:fechaLarga(inicio),fecha_fin:fechaLarga(fin),cliente:c.proyecto,contrato:c.nombre});
  const bytes=doc.getZip().generate({type:"uint8array"});
  const path=`${c.cliente_id}/renovaciones/${c.id}-${fin}.docx`;
  const up=await sb.storage.from("contratos").upload(path,bytes,{contentType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",upsert:true});
  if(up.error) throw up.error;
  return path;
}

Deno.serve(async(req)=>{
  if(req.method!=="POST") return new Response("Method not allowed",{status:405});
  if(!automationKey || req.headers.get("apikey")!==automationKey) return new Response("Unauthorized",{status:401});
  const hoy=iso(new Date());
  const objetivo=iso(new Date(Date.now()+15*86400000));
  const {data:contratos,error}=await sb.from("v_contratos_v2").select("*").eq("fecha_vencimiento",objetivo).neq("estado","terminado");
  if(error) return Response.json({error:error.message},{status:500});
  const resultados:any[]=[];
  for(const c of contratos||[]){
    try{
      const {data:contactos}=await sb.from("contrato_contactos").select("*").eq("cliente_id",c.cliente_id);
      const lider=contactos?.find((x:any)=>x.rol==="lider"); const jefe=contactos?.find((x:any)=>x.rol==="jefe");
      const clientes=(contactos||[]).filter((x:any)=>x.rol==="cliente").map((x:any)=>x.email);
      if(!c.renovacion_automatica){
        const {data:ya}=await sb.from("contrato_notificaciones").select("id").eq("contrato_id",c.id).eq("tipo","alerta_revision").eq("fecha_vencimiento",c.fecha_vencimiento).maybeSingle();
        if(ya) continue;
        await enviar([lider?.email,jefe?.email,...clientes].filter(Boolean),`Alerta: ${c.nombre} vence el ${fechaLarga(c.fecha_vencimiento)}`,`<p>El contrato <b>${c.nombre}</b> requiere revisión. Su vigencia termina el <b>${fechaLarga(c.fecha_vencimiento)}</b>.</p>`);
        await sb.from("contrato_notificaciones").insert({contrato_id:c.id,tipo:"alerta_revision",fecha_vencimiento:c.fecha_vencimiento});
        resultados.push({id:c.id,tipo:"alerta"}); continue;
      }
      if(!lider||!jefe) throw new Error("Falta líder o jefe para aprobación");
      const meses=c.periodo_meses||12, inicioNuevo=sumarDias(c.fecha_vencimiento,1), finNuevo=sumarDias(sumarMeses(inicioNuevo,meses),-1);
      const documento=await generarDocumento(c,inicioNuevo,finNuevo);
      const {data:ren,error:errRen}=await sb.from("contrato_renovaciones").insert({contrato_id:c.id,fecha_inicio_anterior:c.fecha_inicio,fecha_fin_anterior:c.fecha_vencimiento,fecha_inicio_nueva:inicioNuevo,fecha_fin_nueva:finNuevo,documento_path:documento}).select().single();
      if(errRen){ if(errRen.code==="23505") continue; throw errRen; }
      const {data:signed}=await sb.storage.from("contratos").createSignedUrl(documento,604800);
      const link=(token:string,decision:boolean)=>`${appUrl}?aprobacion=${token}&decision=${decision?'aprobar':'rechazar'}`;
      const html=(nombre:string,token:string)=>`<p>Hola ${nombre},</p><p>El contrato <b>${c.nombre}</b> propone una nueva vigencia del <b>${fechaLarga(inicioNuevo)}</b> al <b>${fechaLarga(finNuevo)}</b>.</p><p><a href="${link(token,true)}">Aprobar renovación</a> &nbsp; <a href="${link(token,false)}">Rechazar</a></p>`;
      await enviar([lider.email],`Aprobación de renovación: ${c.nombre}`,html(lider.nombre,ren.token_lider),{path:signed!.signedUrl,filename:`Renovacion-${c.nombre}.docx`});
      await enviar([jefe.email],`Aprobación de renovación: ${c.nombre}`,html(jefe.nombre,ren.token_jefe),{path:signed!.signedUrl,filename:`Renovacion-${c.nombre}.docx`});
      resultados.push({id:c.id,tipo:"renovacion"});
    }catch(e){ resultados.push({id:c.id,error:String(e)}); }
  }
  const {data:aprobadas}=await sb.from("contrato_renovaciones").select("*,contratos(*,clientes(nombre))").eq("estado","aprobado").is("procesado_en",null);
  for(const r of aprobadas||[]){
    try{
      await sb.from("contratos").update({fecha_inicio:r.fecha_inicio_nueva,fecha_vencimiento:r.fecha_fin_nueva,archivo_path:r.documento_path,estado:"vigente"}).eq("id",r.contrato_id);
      const {data:contactos}=await sb.from("contrato_contactos").select("email").eq("cliente_id",r.contratos.cliente_id);
      const {data:signed}=await sb.storage.from("contratos").createSignedUrl(r.documento_path,604800);
      await enviar((contactos||[]).map((x:any)=>x.email),`Contrato actualizado: ${r.contratos.nombre}`,`<p>El contrato <b>${r.contratos.nombre}</b> fue aprobado y actualizado. Estará vigente hasta el <b>${fechaLarga(r.fecha_fin_nueva)}</b>.</p>`,{path:signed!.signedUrl,filename:`Contrato-${r.contratos.nombre}.docx`});
      await sb.from("contrato_renovaciones").update({estado:"aplicado",procesado_en:new Date().toISOString(),notificado_en:new Date().toISOString()}).eq("id",r.id);
    }catch(e){ resultados.push({renovacion:r.id,error:String(e)}); }
  }
  return Response.json({hoy,objetivo,resultados});
});
