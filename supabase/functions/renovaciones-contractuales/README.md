# Renovaciones contractuales

1. Ejecute la migración de `supabase/migrations` en Supabase.
2. Despliegue la función `renovaciones-contractuales`.
3. Configure los secretos `RESEND_API_KEY`, `APP_URL`, `EMAIL_FROM` y `AUTOMATION_KEY`.
4. Verifique el dominio remitente en Resend.
5. Cree en Vault `project_url` y el mismo valor de `AUTOMATION_KEY` bajo el nombre `automation_key`.
6. Active el job incluido al final de la migración.

Las plantillas deben ser `.docx` e incluir `{{fecha_inicio}}` y `{{fecha_fin}}` como texto continuo. También están disponibles `{{cliente}}` y `{{contrato}}`.
