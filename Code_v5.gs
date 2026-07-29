/**
 * PARTE TEST — Apps Script v3 (единое приложение, авторизация по PIN)
 *
 * СХЕМА ДАННЫХ:
 * - PARTE DE TRABAJO: главный журнал. Каждый отчёт рабочего пишется сюда сразу
 *   при отправке со статусом pending/approved/rejected + COMENTARIO_MANAGER
 *   (заполняется только при rejected, очищается при approved).
 * - INFORME: реестр только согласованных записей — дублируется сюда автоматически
 *   в момент approve. Чистые финальные данные без статусных полей.
 *
 * Роли: operario (форма отчёта + "Mis informes"),
 *       manager (согласование заявок по парам CLIENTE:OBRA),
 *       admin   (дашборд: PARTE DE TRABAJO с фильтрами + отдельно INFORME)
 */

var SHEET_PARTE     = "PARTE DE TRABAJO";
var SHEET_INFORME   = "INFORME";
var SHEET_SERVICIO  = "servicio";
var SHEET_USUARIOS  = "USUARIOS";
var SHEET_COUNTER   = "COUNTER";
var SHEET_OPERARIOS_TG = "OPERARIOS_TG";
var SHEET_INFORMES_GENERADOS = "INFORMES_GENERADOS";

var PRICE_PER_HOUR = 28;

// Índices (0-based) de las 21 columnas que PARTE/INFORME comparten —
// ID|STATUS|FECHA|CLIENTE|OBRA|OPERARIO|AYUDANTE|VEHÍCULO|TRABAJOS|
// FOTOS_OBRA|TIPO|HORAS|COMPAÑÍA|MATERIALES|FOTO_MAT|PRECIO|TOTAL|
// TIMESTAMP|COMENTARIO_MANAGER|FECHA_DECISION|MANAGER_NOMBRE (ver
// comentario del data model en CLAUDE.md). COL es SOLO para PARTE (21
// columnas, sin cambios). INFORME tiene una 22ª columna EXTRA propia,
// PRECIO_HORA — pedido explícito: va INMEDIATAMENTE junto a HORAS (columna
// M), no al final, así que TODO lo que en INFORME viene después de HORAS
// (COMPAÑÍA en adelante) queda desplazado +1 respecto a PARTE. Por eso
// existe INFORME_COL como mapa APARTE — cualquier función que lea/escriba
// filas de INFORME debe usar INFORME_COL, nunca COL, para los campos
// COMPANIA/MATERIALES/FOTO_MAT/PRECIO/TOTAL/TIMESTAMP/COMENTARIO_MANAGER/
// FECHA_DECISION/MANAGER_NOMBRE (ID..HORAS coinciden en las dos hojas, esos
// sí se pueden leer con COL indistintamente).
var COL = {
  ID:0, STATUS:1, FECHA:2, CLIENTE:3, OBRA:4, OPERARIO:5, AYUDANTE:6, VEHICULO:7,
  TRABAJOS:8, FOTOS_OBRA:9, TIPO:10, HORAS:11, COMPANIA:12, MATERIALES:13, FOTO_MAT:14,
  PRECIO:15, TOTAL:16, TIMESTAMP:17, COMENTARIO_MANAGER:18, FECHA_DECISION:19, MANAGER_NOMBRE:20
};
var INFORME_COL = {
  ID:0, STATUS:1, FECHA:2, CLIENTE:3, OBRA:4, OPERARIO:5, AYUDANTE:6, VEHICULO:7,
  TRABAJOS:8, FOTOS_OBRA:9, TIPO:10, HORAS:11, PRECIO_HORA:12, COMPANIA:13, MATERIALES:14,
  FOTO_MAT:15, PRECIO:16, TOTAL:17, TIMESTAMP:18, COMENTARIO_MANAGER:19, FECHA_DECISION:20, MANAGER_NOMBRE:21
};
var INFORME_PRECIO_HORA_COL = INFORME_COL.PRECIO_HORA; // 0-based → columna M (13ª), junto a HORAS

// ── SECRETOS: ya NO viven en el código fuente. Se leen de
// PropertiesService (Extensiones → Propiedades del proyecto → Propiedades
// del script) — así el código se puede pegar en un repo, un chat o un
// mensaje sin exponer credenciales reales.
//
// PASO ÚNICO ANTES DEL PRIMER DEPLOY: ejecuta esto UNA vez desde el editor
// de Apps Script (▶ Run sobre setupSecrets), luego BORRA los valores de
// aquí abajo (o deja la función, no hace daño dejarla, solo no la vuelvas
// a correr con las claves antiguas si las rotas).
// BUG REAL encontrado el 2026-07-28: esta función SOBREESCRIBÍA
// incondicionalmente TODAS las propiedades cada vez que se ejecutaba —
// si alguien la volvía a correr por error (p.ej. probando algo en el
// editor) con los valores de plantilla de abajo sin actualizar, pisaba
// en silencio la clave REAL ya guardada con el placeholder
// "PON_AQUI_LA_API_KEY_REAL", dejando TODAS las notificaciones push
// muertas (OneSignal responde 401, "Access denied") sin ningún error
// visible en la propia app — así se rompió esta vez. Ahora solo rellena
// las propiedades que están VACÍAS; una ya guardada nunca se toca,
// aunque el valor de aquí abajo sea distinto. Para ROTAR una clave de
// verdad, edítala directamente en Extensiones ▸ Apps Script ▸ ⚙
// Configuración del proyecto ▸ Propiedades del script — no reutilices
// esta función para eso.
function setupSecrets() {
  var props = PropertiesService.getScriptProperties();
  var defaults = {
    TG_TOKEN:          'PON_AQUI_EL_TOKEN_REAL',
    TG_CHAT_BOB:       '-1004323065789',
    ONESIGNAL_APP_ID:  '9a409dcc-a927-47e6-a37b-7955d5ef84f2',
    ONESIGNAL_API_KEY: 'PON_AQUI_LA_API_KEY_REAL'
  };
  var toSet = {};
  Object.keys(defaults).forEach(function (k) {
    if (!props.getProperty(k)) toSet[k] = defaults[k]; // solo si falta de verdad
  });
  if (Object.keys(toSet).length) {
    props.setProperties(toSet);
    Logger.log('✅ Rellenadas (estaban vacías): ' + Object.keys(toSet).join(', '));
  } else {
    Logger.log('Nada que hacer — ya había un valor guardado para todo. Si necesitas cambiar uno, edítalo a mano en Propiedades del script.');
  }
}

var _props = PropertiesService.getScriptProperties();
var TG_TOKEN          = _props.getProperty('TG_TOKEN');
var TG_CHAT_BOB        = _props.getProperty('TG_CHAT_BOB');
var ONESIGNAL_APP_ID   = _props.getProperty('ONESIGNAL_APP_ID');
var ONESIGNAL_API_KEY  = _props.getProperty('ONESIGNAL_API_KEY');

// Client ID de Google Sign-In — es público (no es un secreto, va también
// en el frontend), así que vive aquí como constante normal, no en
// PropertiesService. Lo genera el usuario en Google Cloud Console
// (OAuth consent screen → Credentials → OAuth client ID → Web application
// → Authorized JavaScript origins: https://bobarus.github.io). Vacío =
// Google Sign-In desactivado (googleLogin() lo comprueba y lanza error
// legible en vez de dejar pasar tokens sin validar audiencia).
var GOOGLE_CLIENT_ID = '260208290245-s98s7p4g29b4e2nvhbqvudmkcse8u0ic.apps.googleusercontent.com';

// BUG CORREGIDO ("al tocar el push se abre un 404"): ninguna llamada a
// sendPushOneSignal() indicaba una URL de destino, así que OneSignal
// abría la raíz del dominio (https://bobarus.github.io/) — que no existe
// como sitio propio, la app real vive en el subdirectorio /AEDIS_APP/.
// Toda notificación debe llevar SIEMPRE esta URL base (+ query params
// para deep-link a un informe concreto, ver buildAppUrl más abajo).
var BASE_URL = "https://aedisapp.github.io/aedis/";

// Construye el enlace de un informe concreto para que el push abra
// DIRECTAMENTE esa pantalla — nunca la app "en blanco". mode:
// "view"  → detalle expandido de solo lectura (o con botones de decisión
//           para manager/admin).
// "edit"  → directo al formulario de edición (solo tiene sentido para el
//           operario dueño de un informe rechazado).
function buildAppUrl(id, mode) {
  return BASE_URL + '?openReport=' + encodeURIComponent(id) + '&mode=' + (mode || 'view');
}

/*
 * Структура колонок PARTE DE TRABAJO (21 колонка):
 * 1 ID | 2 STATUS | 3 FECHA | 4 CLIENTE | 5 OBRA | 6 OPERARIO | 7 AYUDANTE
 * 8 VEHÍCULO | 9 TRABAJOS REALIZADOS | 10 FOTOS DE OBRA | 11 TIPO DE TRABAJO
 * 12 HORAS | 13 COMPAÑÍA | 14 MATERIALES UTILIZADOS | 15 FOTO MATERIALES / RECIBO
 * 16 PRECIO (EUR) | 17 TOTAL | 18 TIMESTAMP | 19 COMENTARIO_MANAGER
 * 20 FECHA_DECISION | 21 MANAGER_NOMBRE
 *
 * Структура колонок INFORME (16 колонок, как в боевом проекте — без статусных полей):
 * FECHA | CLIENTE | OBRA | OPERARIO | AYUDANTE | VEHÍCULO | TRABAJOS REALIZADOS
 * | FOTOS DE OBRA | TIPO DE TRABAJO | HORAS | COMPAÑÍA | MATERIALES UTILIZADOS
 * | FOTO MATERIALES / RECIBO | PRECIO (EUR) | TOTAL | TIMESTAMP
 */

function out(data, callback) {
  var json = JSON.stringify(data);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── FUNCIÓN DE PRUEBA — enviar un push de test sin tocar la hoja ──
// Se ejecuta manualmente desde el editor de Apps Script (botón ▶ Run),
// seleccionando esta función en el desplegable. No crea ninguna fila.
function testPush() {
  var testPin = '1111'; // ← cambia esto por el PIN que quieras probar
  sendPushOneSignal([testPin], 'AEDIS (prueba)', 'Esto es una notificación de prueba', 'test_' + Date.now());
  Logger.log('Push de prueba enviado a PIN ' + testPin);
}

/* 2026-07-28 — pedido tras un reporte de "llevan un par de días sin
 * llegar NINGUNA notificación". testPush() de arriba ya existía pero
 * hay que ir a Ver ▸ Registros para ver el resultado, y solo envía —
 * nunca dice SI de verdad llegó ni por qué no. Este diagnóstico hace la
 * llamada a OneSignal directamente (sin pasar por sendPushOneSignal, que
 * reintenta 3 veces y no devuelve nada) y muestra el código HTTP real +
 * el cuerpo de la respuesta en un popup, sin tener que abrir logs. Envía
 * a un admin activo de verdad (el primero de getAdminPins()), no al PIN
 * de prueba hardcodeado — así también confirma que ese admin concreto
 * está bien vinculado en OneSignal. No escribe nada en la hoja. */
function diagnosticoNotificaciones() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty('ONESIGNAL_APP_ID');
  var apiKey = props.getProperty('ONESIGNAL_API_KEY');
  var admins = getAdminPins();

  var lines = [];
  lines.push('ONESIGNAL_APP_ID: ' + (appId ? (appId.length + ' caracteres, empieza "' + appId.substring(0, 8) + '..."') : '❌ VACÍO O NO EXISTE'));
  lines.push('ONESIGNAL_API_KEY: ' + (apiKey ? (apiKey.length + ' caracteres, empieza "' + apiKey.substring(0, 6) + '..."') : '❌ VACÍO O NO EXISTE'));
  lines.push('Admins activos: ' + admins.length + (admins.length ? ' (PIN ' + admins.join(', ') + ')' : ' ❌ NINGUNO — nadie recibiría avisos de admin'));

  if (!appId || !apiKey) {
    lines.push('');
    lines.push('→ Faltan credenciales en Propiedades del script (Extensiones ▸ Propiedades del proyecto ▸ Propiedades del script). Sin esto NINGUNA notificación puede salir, para nadie.');
    ui.alert('Diagnóstico de notificaciones', lines.join('\n'), ui.ButtonSet.OK);
    return;
  }
  if (!admins.length) {
    lines.push('');
    lines.push('→ No hay ningún usuario con rol admin y ACTIVO=TRUE en USUARIOS — no puedo enviar la prueba. Revisa la hoja USUARIOS.');
    ui.alert('Diagnóstico de notificaciones', lines.join('\n'), ui.ButtonSet.OK);
    return;
  }

  var testPin = admins[0];
  var payload = {
    app_id: appId,
    include_external_user_ids: [String(testPin)],
    channel_for_external_user_ids: 'push',
    headings: { en: 'AEDIS (diagnóstico)', es: 'AEDIS (diagnóstico)' },
    contents: { en: 'Prueba de notificación — ' + new Date().toLocaleTimeString(), es: 'Prueba de notificación — ' + new Date().toLocaleTimeString() },
    priority: 10
  };
  lines.push('');
  lines.push('Enviando prueba real a PIN ' + testPin + '...');
  try {
    var response = UrlFetchApp.fetch('https://api.onesignal.com/notifications', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'Authorization': 'Key ' + apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    var body = response.getContentText();
    lines.push('HTTP ' + code + (code >= 200 && code < 300 ? ' ✅' : ' ❌'));
    lines.push(body.substring(0, 500));
  } catch (e) {
    lines.push('❌ Excepción al llamar a OneSignal: ' + e.message);
  }
  ui.alert('Diagnóstico de notificaciones', lines.join('\n'), ui.ButtonSet.OK);
}

function doGet(e) {
  var p  = (e && e.parameter) ? e.parameter : {};
  var cb = p.callback || null;
  try {
    if (p.action === 'getLists')      return out(getListsData(), cb);
    if (p.action === 'checkUser')     return out(checkUser(p), cb);
    // BUG CORREGIDO (seguridad): 'save' escribía datos y aceptaba GET —
    // el PIN y los datos del informe acababan en la query string, y por
    // tanto en logs de Apps Script/proxies e historial del navegador.
    // Toda acción que escribe datos debe ir SOLO por POST (ver doPost).
    if (p.action === 'getPending')    return out(getPendingForUser(p), cb);
    if (p.action === 'approve')       return out(approveRecord(p), cb);
    if (p.action === 'reject')        return out(rejectRecord(p), cb);
    if (p.action === 'getMyReports')  return out(getMyReports(p), cb);
    if (p.action === 'resubmit')      return out(resubmitRecord(p), cb);
    if (p.action === 'getAdminStats') return out(getAdminStats(p), cb);
    if (p.action === 'getInforme')    return out(getInforme(p), cb);
    if (p.action === 'getAnalyticsSummary') return out(getAnalyticsSummary(p), cb);
    if (p.action === 'getObjectsBreakdown') return out(getObjectsBreakdown(p), cb);
    if (p.action === 'getAnalyticsDrilldown') return out(getAnalyticsDrilldown(p), cb);
    if (p.action === 'buildReportPreview') return out(buildReportPreview(p), cb);
    if (p.action === 'listGeneratedReports') return out(listGeneratedReports(p), cb);
    if (p.action === 'getHistorial')  return out(getHistorial(p), cb);
    if (p.action === 'getFolderPhotos') return out(getFolderPhotos(p), cb);
    if (p.action === 'setUserLang')   return out(setUserLang(p), cb);
    // AUTH v2 — lecturas
    if (p.action === 'getStatusFor')       return out(getStatusFor(p), cb);
    if (p.action === 'getClienteObraPairs') return out(getClienteObraPairs(p), cb);
    if (p.action === 'adminListUsers')     return out(adminListUsers(p), cb);
    return out({ status:'ok', message:'Parte TEST API v3' }, cb);
  } catch(err) {
    Logger.log('doGet error: ' + err.message);
    return out({ status:'error', message:err.message }, cb);
  }
}

function doPost(e) {
  try {
    var raw = '';
    if (e.parameter && e.parameter.data) {
      raw = e.parameter.data;
    } else if (e.postData && e.postData.contents) {
      raw = e.postData.contents;
    }
    if (!raw) throw new Error('No data');
    var parsed = JSON.parse(raw);
    if (parsed.action === 'approve') return out(approveRecord(parsed));
    if (parsed.action === 'reject')  return out(rejectRecord(parsed));
    if (parsed.action === 'resubmit') return out(resubmitRecord(parsed));
    if (parsed.action === 'adminSaveReport') return out(adminSaveReport(parsed));
    if (parsed.action === 'deleteRecord') return out(deleteRecord(parsed));
    // BUG CORREGIDO (seguridad): testPhotoUpload quedaba accesible en
    // producción sin ningún PIN — era básicamente un subidor de archivos
    // anónimo y gratuito a tu Drive con enlace público. Se restringe a
    // admin. Si necesitas volver a diagnosticar, pide el PIN de admin.
    if (parsed.action === 'testPhotoUpload') {
      var authTest = checkUser(parsed);
      if (!authTest.valid || authTest.rol !== 'admin') return out({ status:'error', message:'No autorizado' });
      return out(testPhotoUploadHandler(parsed));
    }
    if (parsed.action === 'uploadReportPhotos') return out(uploadReportPhotos(parsed));
    if (parsed.action === 'deletePhoto') return out(deleteReportPhoto(parsed));
    // AUTH v2 — escrituras
    if (parsed.action === 'registerUser')    return out(registerUser(parsed));
    if (parsed.action === 'resendOtp')       return out(resendOtp(parsed));
    if (parsed.action === 'verifyOtp')       return out(verifyOtp(parsed));
    if (parsed.action === 'loginPassword')   return out(loginPassword(parsed));
    if (parsed.action === 'googleLogin')     return out(googleLogin(parsed));
    if (parsed.action === 'adminApproveUser') return out(adminApproveUser(parsed));
    if (parsed.action === 'adminRejectUser')  return out(adminRejectUser(parsed));
    if (parsed.action === 'adminUpdateUser')  return out(adminUpdateUser(parsed));
    if (parsed.action === 'adminSetUserCode') return out(adminSetUserCode(parsed));
    if (parsed.action === 'adminResetPassword') return out(adminResetPassword(parsed));
    if (parsed.action === 'adminDeleteUser') return out(adminDeleteUser(parsed));
    if (parsed.action === 'generateStatReport') return out(generateStatReport(parsed));
    if (parsed.action === 'replaceHourlyRate') return out(replaceHourlyRate(parsed));
    if (parsed.action === 'deleteGeneratedReport') return out(deleteGeneratedReport(parsed));
    return out(saveReport(parsed));
  } catch(err) {
    Logger.log('doPost error: ' + err.message);
    return out({ status:'error', message:err.message });
  }
}

/* ── BRUTE-FORCE GUARD: el PIN es de solo 4 dígitos (10.000 combinaciones)
 * y el endpoint es público — sin esto, sería trivial de perforar con un
 * script. Cache compartido por todas las ejecuciones del script, 6 horas
 * de vida por entrada. Bloquea 15 min tras 5 intentos fallidos SEGUIDOS
 * para un mismo código (el contador se resetea en cuanto ese código
 * acierta o cuando expira el bloqueo). */
var MAX_INTENTOS_PIN = 5;
var BLOQUEO_MINUTOS  = 15;

function pinBloqueado(codigo) {
  var cache = CacheService.getScriptCache();
  var key = 'pin_fail_' + codigo;
  var raw = cache.get(key);
  if (!raw) return false;
  var data = JSON.parse(raw);
  return data.count >= MAX_INTENTOS_PIN;
}

function registrarIntentoFallido(codigo) {
  var cache = CacheService.getScriptCache();
  var key = 'pin_fail_' + codigo;
  var raw = cache.get(key);
  var data = raw ? JSON.parse(raw) : { count: 0 };
  data.count++;
  cache.put(key, JSON.stringify(data), BLOQUEO_MINUTOS * 60);
}

function limpiarIntentosFallidos(codigo) {
  CacheService.getScriptCache().remove('pin_fail_' + codigo);
}

/* ── AUTH: проверка PIN, возвращает роль/имя/объекты ── */
function checkUser(p) {
  var codigo = String(p.codigo || '').trim();
  if (!codigo) return { status:'error', message:'No code' };

  if (pinBloqueado(codigo)) {
    return { status:'error', valid:false, blocked:true,
             message:'Demasiados intentos fallidos. Espera ' + BLOQUEO_MINUTOS + ' minutos.' };
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_USUARIOS);

  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var rowCodigo = String(r[0]).trim();
    var activo = String(r[4]).trim().toUpperCase();
    if (rowCodigo === codigo && activo === 'TRUE') {
      limpiarIntentosFallidos(codigo);
      var rol    = String(r[1]).trim();
      var nombre = String(r[2]).trim();
      var obrasRaw = String(r[3]).trim();
      var langRaw = String(r[5] || '').trim().toLowerCase();
      var pares = [];
      if (obrasRaw !== '*') {
        obrasRaw.split(',').forEach(function(pair){
          var parts = pair.split(':');
          if (parts.length === 2) {
            pares.push({ cliente: parts[0].trim(), obra: parts[1].trim() });
          }
        });
      }
      return {
        status: 'ok', valid: true,
        rol: rol, nombre: nombre,
        allAccess: (obrasRaw === '*'),
        obras: pares,
        lang: (langRaw === 'ru' || langRaw === 'en') ? langRaw : 'es'
      };
    }
  }
  registrarIntentoFallido(codigo);
  return { status:'ok', valid:false };
}

/* ── IDIOMA DEL USUARIO: columna F de USUARIOS ── */
function setUserLang(p) {
  var codigo = String(p.codigo || '').trim();
  var lang = String(p.lang || '').trim().toLowerCase();
  if (!codigo) return { status:'error', message:'No code' };
  if (lang !== 'ru' && lang !== 'en') lang = 'es';

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === codigo) {
      sheet.getRange(i + 1, 6).setValue(lang); // columna F
      return { status:'ok' };
    }
  }
  return { status:'error', message:'PIN no encontrado' };
}

// Cliente y obra son listas independientes en la hoja 'servicio' (no pares
// fijos por fila — ver getListsData) — un permiso puede ser un par exacto
// "cliente:obra" (compatibilidad con datos antiguos), o un comodín:
// "cliente:*" (todos los objetos de ese cliente) u "*:obra" (ese objeto en
// cualquier cliente, para el caso "cada objeto tiene su propio manager").
function userCanAccess(userInfo, cliente, obra) {
  // BUG CORREGIDO (pedido 2026-07-29, "admin no puede crear/aprobar un
  // informe de según qué objeto"): allAccess solo era true si la columna
  // OBRAS de USUARIOS valía literalmente '*' para esa fila — un admin
  // cuya propia fila no tuviera ese valor exacto (p.ej. vacía, o con una
  // lista concreta heredada de cuando era manager) quedaba tan limitado
  // como cualquier manager normal, pese al rol. El acceso de admin debe
  // ser incondicional, no depender de ese dato.
  if (userInfo.rol === 'admin') return true;
  if (userInfo.allAccess) return true;
  for (var i = 0; i < userInfo.obras.length; i++) {
    var g = userInfo.obras[i];
    var clienteOk = (g.cliente === '*' || g.cliente === cliente);
    var obraOk = (g.obra === '*' || g.obra === obra);
    if (clienteOk && obraOk) return true;
  }
  return false;
}

/* ════════ AUTH v2: registro con verificación de email, login por
 * contraseña/Google, aprobación por admin ════════
 * USUARIOS pasa de 6 a 16 columnas. Las 6 primeras (A-F, índices r[0]..r[5])
 * son las de siempre (CODIGO/ROL/NOMBRE/OBRAS/ACTIVO/LANG) y NO se tocan —
 * checkUser/getPinsWithAccess/etc. de arriba siguen funcionando igual.
 * Las nuevas (G-P) son aditivas:
 *   G APELLIDO | H EMAIL | I TELEFONO | J PASSWORD_HASH | K PASSWORD_SALT
 *   L GOOGLE_SUB | M STATUS | N ID_USUARIO | O OTP_CODE | P OTP_EXPIRES
 *
 * Ejecuta migrateUsuariosSchema() UNA vez desde el editor de Apps Script
 * antes de usar nada de este bloque — solo añade las cabeceras que falten,
 * nunca toca datos existentes.
 */
var USR_COL = {
  CODIGO:0, ROL:1, NOMBRE:2, OBRAS:3, ACTIVO:4, LANG:5,
  APELLIDO:6, EMAIL:7, TELEFONO:8, PASSWORD_HASH:9, PASSWORD_SALT:10,
  GOOGLE_SUB:11, STATUS:12, ID_USUARIO:13, OTP_CODE:14, OTP_EXPIRES:15
};

var OTP_TTL_MINUTES = 10;
var OTP_RESEND_COOLDOWN_SECONDS = 45;

function migrateUsuariosSchema() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_USUARIOS);
  var headers = ['CODIGO','ROL','NOMBRE','OBRAS','ACTIVO','LANG','APELLIDO','EMAIL','TELEFONO','PASSWORD_HASH','PASSWORD_SALT','GOOGLE_SUB','STATUS','ID_USUARIO','OTP_CODE','OTP_EXPIRES'];
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var current = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (!current[i] || String(current[i]).trim() === '') {
      sheet.getRange(1, i + 1).setValue(headers[i]);
    }
  }
  var counterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_COUNTER);
  if (counterSheet && !counterSheet.getRange(2, 2).getValue()) {
    counterSheet.getRange(2, 2).setValue(0);
  }
  Logger.log('✅ USUARIOS: cabeceras al día. COUNTER B2 (contador ID_USUARIO) listo.');
}

/* ── Módulo de informes estadísticos (PDF/Excel) — ejecuta esto UNA vez
 * desde el editor de Apps Script antes de usar nada de ese módulo (y de
 * nuevo, sin problema, si hace falta reordenar — es idempotente).
 * Coloca PRECIO_HORA en la columna M de INFORME (junto a HORAS, ver
 * INFORME_COL más arriba), crea la hoja INFORMES_GENERADOS si no existe,
 * y reserva COUNTER!C2 como tercer contador independiente (A2=PT-XXXX,
 * B2=U-XXXX, C2=RPT-XXXX).
 * Pedido posterior: la columna vivía al FINAL (V) en la primera versión
 * de este módulo — se movió junto a HORAS por legibilidad. Esta función
 * ahora cubre los 3 casos posibles: (1) ya está en M — no toca nada; (2)
 * todavía está en la V de la versión vieja — la MUEVE (inserta una
 * columna en M, copia los valores, borra la V vieja) preservando
 * cualquier tarifa que el admin ya haya editado a mano; (3) no existe en
 * ningún sitio (primera vez) — inserta la columna nueva en M. */
function migrateInformesModule() {
  var sheetI = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORME);
  if (!sheetI) throw new Error('Sheet not found: ' + SHEET_INFORME);

  var newCol = INFORME_COL.PRECIO_HORA + 1; // columna M (13), junto a HORAS
  var headerAtNewCol = String(sheetI.getRange(1, newCol).getValue() || '').trim();

  if (headerAtNewCol !== 'PRECIO_HORA') {
    var oldCol = 22; // V — posición de la primera versión de este módulo
    var headerAtOldCol = String(sheetI.getRange(1, oldCol).getValue() || '').trim();
    if (headerAtOldCol === 'PRECIO_HORA') {
      var lastRow = Math.max(sheetI.getLastRow(), 1);
      var values = sheetI.getRange(1, oldCol, lastRow, 1).getValues();
      sheetI.insertColumnBefore(newCol);
      sheetI.getRange(1, newCol, values.length, 1).setValues(values);
      sheetI.deleteColumn(oldCol + 1); // la V vieja se desplazó +1 al insertar la columna nueva
      Logger.log('✅ PRECIO_HORA movida de la columna V a la M (junto a HORAS), datos existentes conservados.');
    } else {
      sheetI.insertColumnBefore(newCol);
      sheetI.getRange(1, newCol).setValue('PRECIO_HORA');
      Logger.log('✅ Columna PRECIO_HORA creada en la posición M (junto a HORAS).');
    }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetRG = ss.getSheetByName(SHEET_INFORMES_GENERADOS);
  if (!sheetRG) {
    sheetRG = ss.insertSheet(SHEET_INFORMES_GENERADOS);
    sheetRG.appendRow(['ID','FECHA_CREACION','CREADO_POR','PERIODO_DESDE','PERIODO_HASTA','FORMATO','OBJETOS','PCT_MATERIALES','PCT_TRABAJO','PRECIO_HORA_OVERRIDE','DRIVE_FILE_URL','STATUS']);
  }

  var counterSheet = ss.getSheetByName(SHEET_COUNTER);
  if (counterSheet && !counterSheet.getRange(2, 3).getValue()) {
    counterSheet.getRange(2, 3).setValue(0);
  }
  Logger.log('✅ INFORME: columna PRECIO_HORA lista. Hoja INFORMES_GENERADOS lista. COUNTER C2 (contador RPT-XXXX) listo.');
}

// EST_CELLS ya NO son direcciones A1 fijas — son nombres de RANGOS CON
// NOMBRE ("Named ranges" de Sheets). Pedido explícito del usuario: poder
// reordenar/mover celdas sin que las fórmulas se rompan. Un rango con
// nombre "sigue" a la celda aunque el usuario la mueva (cortar-pegar,
// insertar/eliminar filas o columnas alrededor) — una dirección $A$5
// fija NO lo hace. Único sitio de verdad, compartido entre
// _buildEstadisticasSheetContent (que los crea con _estSetNamedRange),
// createReportFromSheetFilters (que los lee con ss.getRangeByName) y
// refreshEstadisticasFormulas (que los reutiliza para no tener que saber
// dónde está cada cosa).
var EST_SHEET_NAME = 'ESTADÍSTICAS';
// TARIFA (override manual de €/h en el filtro) retirado el 2026-07-27
// (continuación) — no hacía nada real, ver reemplazarTarifaPeriodo().
var EST_CELLS = {
  DESDE: 'EST_DESDE', HASTA: 'EST_HASTA', CLIENTE: 'EST_CLIENTE', OBRA: 'EST_OBRA', OPERARIO: 'EST_OPERARIO',
  PCT_MATERIALES: 'EST_PCT_MAT', PCT_TRABAJO: 'EST_PCT_TRAB',
  FORMATO: 'EST_FORMATO', RESULTADO: 'EST_RESULTADO'
};
// EN DESUSO desde el 2026-07-27 (dejó de usarse en ninguna fórmula viva —
// solo servía para comparación EXACTA de un único valor, incompatible con
// la multiselección de Cliente/Objeto/Trabajador; ver _estTileFormulas()
// y el TOTAL de _estApplyFiltroFormulas, que ahora reutilizan
// _estWhereClause() en su lugar). Se deja declarada, sin borrar, por si
// algo externo a este archivo llegara a referenciarla.
var EST_WILDCARD_CRIT = 'INFORME!C2:C,">="&EST_DESDE,INFORME!C2:C,"<="&EST_HASTA,INFORME!D2:D,IF(EST_CLIENTE="(Todos)","<>",EST_CLIENTE),INFORME!E2:E,IF(EST_OBRA="(Todos)","<>",EST_OBRA),INFORME!F2:F,IF(EST_OPERARIO="(Todos)","<>",EST_OPERARIO)';

// Crea (o reemplaza si ya existía) un rango con nombre — idempotente,
// seguro de llamar en cada regeneración/actualización sin acumular
// nombres duplicados o apuntando a hojas ya borradas.
function _estSetNamedRange(ss, name, range) {
  ss.getNamedRanges().forEach(function (nr) { if (nr.getName() === name) nr.remove(); });
  ss.setNamedRange(name, range);
}

/* Simple trigger — Apps Script lo reconoce por el nombre exacto "onOpen"
 * (igual que onEdit) y no necesita instalación manual desde el menú
 * Triggers. Construye el menú "AEDIS" cada vez que se abre/recarga la
 * spreadsheet. */
function onOpen() {
  // Pedido explícito 2026-07-27 (quinta continuación): esto va ANTES de
  // construir el menú y ANTES de cualquier recálculo pesado — descubierto
  // en vivo que Desde/Hasta a veces sí se restablecían y a veces no, pese
  // a que el código es correcto (confirmado por separado) y no hay
  // triggers instalables de por medio (confirmado con
  // diagnosticoTriggers()). Hipótesis con más peso: los triggers SIMPLES
  // (onOpen sin instalar) tienen un límite de tiempo de ejecución más
  // corto que una ejecución manual — y este onOpen, con 4 bloques
  // recalculándose en Apps Script (tiles, "Resultados según filtro",
  // "Informes del período", "RESUMEN GENERAL (año)"), ya tardaba 15-25s
  // en los logs de Ejecuciones, con margen real para exceder ese límite
  // según la carga del servidor en cada apertura — si eso pasa, la
  // ejecución se corta a medias SIN lanzar una excepción que el propio
  // try/catch pueda registrar. Poner el reseteo de fecha (2 escrituras,
  // milisegundos) como lo PRIMERO que hace la función entera lo deja a
  // salvo de que el resto tarde demasiado y se corte.
  try {
    var ssEstFecha = SpreadsheetApp.getActiveSpreadsheet();
    var sheetEstFecha = ssEstFecha.getSheetByName(EST_SHEET_NAME);
    if (sheetEstFecha) _estAplicarRangoPorDefecto(ssEstFecha, sheetEstFecha);
  } catch (err) {
    Logger.log('onOpen: reseteo de Desde/Hasta falló: ' + err.message);
  }

  SpreadsheetApp.getUi().createMenu('AEDIS')
    .addItem('💾 Guardar aspecto actual (sobrevive a Reconstruir)', 'guardarDisenoActual')
    .addItem('🔧 Reparar listas de Cliente/Objeto/Trabajador', 'repararListasDesplegables')
    .addItem('📅 Restablecer Desde/Hasta (1 de este mes → hoy)', 'establecerRangoPorDefecto')
    .addItem('💶 Reemplazar tarifa del periodo actual', 'reemplazarTarifaPeriodo')
    .addItem('🔁 Actualizar fórmulas (mantiene tu diseño)', 'refreshEstadisticasFormulas')
    .addItem('🔌 Conectar tabla "Informes del período"', 'implementarInformesDelPeriodo')
    .addItem('↔️ Mover bloque KPI a columna W', 'moverBloqueKPI')
    .addItem('📥 Reubicar Informes/Trabajadores en I12:J13', 'reorganizarKPIEnResumenGeneral')
    .addItem('🧹 Reparar todo (limpia duplicados y recalcula todo)', 'repararTodoEstadisticas')
    .addItem('🆘 Reparación de emergencia (repara TODO y muestra el resultado)', 'reparacionEmergencia')
    .addItem('🩺 Diagnóstico de posiciones (no cambia nada)', 'debugEstadisticasLayout')
    .addItem('🩺 Diagnóstico de triggers instalables (temporal)', 'diagnosticoTriggers')
    .addItem('🩺 Diagnóstico de notificaciones push (envía una de prueba)', 'diagnosticoNotificaciones')
    .addItem('🩺 Diagnóstico de integridad de INFORME (TOTAL vs horas/tarifa/materiales)', 'diagnosticoIntegridadInforme')
    .addItem('🔔 Activar notificación a admins por tarifa editada a mano (ejecutar 1 vez)', 'instalarTriggerNotificacionTarifa')
    .addItem('⚠️ Reconstruir hoja desde cero (borra tu diseño)', 'createEstadisticasSheet')
    .addToUi();

  // Pedido explícito 2026-07-27: "Crear informe" como su propio menú de
  // nivel superior, al lado de "AEDIS" en la barra — no metido dentro del
  // desplegable de AEDIS. SpreadsheetApp.getUi().createMenu(...).addToUi()
  // añade un menú nuevo cada vez que se llama; llamarlo una segunda vez
  // con otro nombre crea un segundo menú independiente en la misma barra.
  SpreadsheetApp.getUi().createMenu('✅ CREAR INFORME')
    .addItem('📄 Crear informe desde filtros', 'createReportFromSheetFilters')
    .addToUi();

  // Pedido explícito 2026-07-27: recalcula los 3 bloques que ahora viven
  // en Apps Script (no en fórmula) cada vez que se abre/recarga la hoja
  // — Desde/Hasta son fórmulas basadas en HOY() que cambian solas al
  // pasar el día, y ese cambio "silencioso" no dispara onEdit(), así que
  // sin esto la página podía mostrar tablas desincronizadas del rango de
  // fechas que de verdad se ve en los filtros justo después de recargar.
  try {
    var ssEst = SpreadsheetApp.getActiveSpreadsheet();
    var sheetEst = ssEst.getSheetByName(EST_SHEET_NAME);
    if (sheetEst) {
      // Pedido explícito 2026-07-27 (continuación): Desde/Hasta deben
      // volver solos a "1 de este mes → hoy" cada vez que se abre/recarga
      // la página, no solo al pulsar el menú a mano — así una fecha vieja
      // tecleada a mano en una sesión anterior no se queda pegada para
      // siempre. Si el usuario quiere un rango distinto, lo cambia después
      // de abrir; el reseteo solo ocurre en la apertura/recarga real
      // (onOpen), no en cada edición.
      _estAplicarRangoPorDefecto(ssEst, sheetEst);
      _estRefrescarTodoJS(sheetEst);
    }
  } catch (err) {
    Logger.log('onOpen: refresco automático de ESTADÍSTICAS falló: ' + err.message);
  }
}

/* Solo lectura — no escribe nada en la hoja. Pensado para el 2026-07-27:
 * varias secciones de ESTADÍSTICAS llevan tantas rondas de maquetado a
 * mano que ya no está claro, sin mirar, dónde vive cada cosa realmente
 * (p.ej. el bloque "Informes aprobados/.../Total (€)" resultó estar
 * chocando con la nueva tabla "INFORMES DEL PERIODO" sin que fuera obvio
 * desde fuera). En vez de adivinar por capturas de pantalla, esto vuelca
 * la posición REAL de cada rango con nombre + dónde aparece el texto
 * literal de cada título de sección — muéstraselo a quien esté ayudando
 * a depurar en vez de describir la pantalla a mano. */
/* DIAGNÓSTICO TEMPORAL 2026-07-27 — quitar en cuanto se resuelva por qué
 * Desde/Hasta no cambian pese a que onOpen() (confirmado, con el código
 * más reciente) se ejecuta sin errores y, probado por separado, SÍ deja
 * la celda en el valor correcto justo después de escribirla. Hipótesis a
 * comprobar: un trigger INSTALABLE (Activadores/Triggers, distinto del
 * simple onOpen) registrado en algún momento de sesiones anteriores,
 * apuntando a una función vieja, que se ejecuta también al abrir la hoja
 * y revierte el valor después. No cambia nada en la hoja, solo lee. */
/* 2026-07-28 — pedido explícito: "проверить меняется ли корректно
 * стоимость в отчетах в приложении" (verificar si el coste cambia
 * correctamente en los informes de la app). La app siempre lee INFORME
 * en vivo (no hay caché de servidor), así que "¿se ve bien en la app?"
 * es exactamente "¿TOTAL de cada fila coincide con HORAS×PRECIO_HORA+
 * PRECIO?" — mismo cálculo que usa toda la app (Análisis, Diario,
 * exportar informe). Recorre TODO INFORME y lista las filas donde no
 * coincide (con más de 1 céntimo de diferencia, por redondeo de coma
 * flotante) — si la lista sale vacía, el dato está sano de verdad, no
 * es una suposición. No escribe nada, solo lee. */
function diagnosticoIntegridadInforme() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORME);
  if (!sheet) { ui.alert('No existe la hoja ' + SHEET_INFORME + '.'); return; }
  var rows = sheet.getDataRange().getValues();

  var total = 0, mismatches = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[INFORME_COL.ID]) continue;
    total++;
    var horas = parseFloat(r[INFORME_COL.HORAS]) || 0;
    var precioHora = parseFloat(r[INFORME_COL.PRECIO_HORA]) || 0;
    var precioMat = parseFloat(r[INFORME_COL.PRECIO]) || 0;
    var totalReal = parseFloat(r[INFORME_COL.TOTAL]) || 0;
    var totalEsperado = horas * precioHora + precioMat;
    if (Math.abs(totalReal - totalEsperado) > 0.01) {
      mismatches.push(r[INFORME_COL.ID] + ': TOTAL=' + totalReal.toFixed(2) + ' pero ' + horas + 'h×' + precioHora.toFixed(2) + '€+' + precioMat.toFixed(2) + '€=' + totalEsperado.toFixed(2));
    }
  }

  var lines = ['Filas revisadas: ' + total, 'Con TOTAL desincronizado: ' + mismatches.length, ''];
  if (mismatches.length) {
    lines = lines.concat(mismatches.slice(0, 15));
    if (mismatches.length > 15) lines.push('… y ' + (mismatches.length - 15) + ' más');
  } else {
    lines.push('✅ Todo coincide — el coste que muestra la app es el correcto en las ' + total + ' filas.');
  }
  ui.alert('Integridad de INFORME', lines.join('\n'), ui.ButtonSet.OK);
}

function diagnosticoTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var lines = triggers.map(function (t) {
    return t.getHandlerFunction() + ' | evento: ' + t.getEventType() + ' | fuente: ' + t.getTriggerSource() + ' | id: ' + t.getUniqueId();
  });
  var msg = triggers.length ? lines.join('\n') : '(ningún trigger instalable registrado — solo el onOpen simple)';
  SpreadsheetApp.getUi().alert('Triggers instalables (' + triggers.length + ')', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

function debugEstadisticasLayout() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  var lines = [];

  var namedRangeNames = [
    'EST_DESDE', 'EST_HASTA', 'EST_CLIENTE', 'EST_OBRA', 'EST_OPERARIO',
    'EST_PCT_MAT', 'EST_PCT_TRAB', 'EST_FORMATO', 'EST_RESULTADO',
    'EST_TILE_TRAB', 'EST_TILE_INF', 'EST_TILE_MAT', 'EST_TILE_REM',
    'EST_FILTRO_TABLE', 'EST_INFORMES_TABLE',
    'EST_YEAR_TITLE', 'EST_YEAR_TABLE', 'EST_YEAR_KPI_TOP'
  ];
  lines.push('— RANGOS CON NOMBRE —');
  namedRangeNames.forEach(function (name) {
    var r = ss.getRangeByName(name);
    lines.push(name + ': ' + (r ? (r.getSheet().getName() + '!' + r.getA1Notation() + ' (fila ' + r.getRow() + ', col ' + r.getColumn() + ')') : 'NO EXISTE'));
  });

  lines.push('');
  lines.push('— TEXTOS DE TÍTULO ENCONTRADOS EN LA HOJA —');
  var titlesToFind = ['RESULTADOS SEGÚN FILTRO', 'INFORMES DEL PERIODO', 'RESUMEN GENERAL'];
  var data = sheet.getDataRange().getValues();
  for (var r = 0; r < data.length; r++) {
    for (var c = 0; c < data[r].length; c++) {
      var cellText = String(data[r][c]).trim();
      for (var t = 0; t < titlesToFind.length; t++) {
        if (cellText.toUpperCase().indexOf(titlesToFind[t]) === 0) {
          lines.push('"' + cellText + '" → fila ' + (r + 1) + ', col ' + (c + 1) + ' (' + _estColLetter(c + 1) + (r + 1) + ')');
        }
      }
    }
  }

  lines.push('');
  lines.push('— ETIQUETAS DEL BLOQUE KPI (Informes aprobados / Trabajadores distintos / Materiales / Trabajo / Total), 5 filas desde donde esté EST_YEAR_KPI_TOP —');
  var kpiTop = ss.getRangeByName('EST_YEAR_KPI_TOP');
  if (kpiTop) {
    var kr = kpiTop.getRow(), kc = kpiTop.getColumn();
    for (var i = 0; i < 5; i++) {
      var labelCell = sheet.getRange(kr + i, kc);
      var valueCell = sheet.getRange(kr + i, kc + 1);
      lines.push((kr + i) + ': "' + labelCell.getValue() + '" = ' + valueCell.getValue() + '  [celda de valor: ' + _estColLetter(kc + 1) + (kr + i) + ']');
    }
  } else {
    lines.push('EST_YEAR_KPI_TOP no existe — no se puede listar.');
  }

  lines.push('');
  lines.push('— "RESULTADOS SEGÚN FILTRO": primeras 7 filas desde EST_FILTRO_TABLE (ya no hay fórmulas ni columna oculta — cálculo en Apps Script) —');
  var filtroAnchor = ss.getRangeByName('EST_FILTRO_TABLE');
  if (filtroAnchor) {
    var fr = filtroAnchor.getRow(), fc = filtroAnchor.getColumn();
    for (var fi = 0; fi < 7; fi++) {
      var row = fr + fi;
      var visCells = [];
      for (var vc = 0; vc < 5; vc++) {
        visCells.push(_estColLetter(fc + vc) + row + '=[' + sheet.getRange(row, fc + vc).getValue() + ']');
      }
      lines.push('fila ' + row + ': ' + visCells.join(' | '));
    }
  } else {
    lines.push('EST_FILTRO_TABLE no existe — no se puede volcar.');
  }

  lines.push('');
  lines.push('— LISTAS OCULTAS DE LOS DESPLEGABLES (T=Cliente, U=Objeto, V=Trabajador), filas 1-6 —');
  ['T', 'U', 'V'].forEach(function (col) {
    for (var lr = 1; lr <= 6; lr++) {
      var lcell = sheet.getRange(col + lr);
      var lf = lcell.getFormula();
      lines.push(col + lr + ': valor=[' + lcell.getValue() + ']' + (lf ? ' fórmula=[' + lf + ']' : ''));
    }
  });

  var msg = lines.join('\n');
  Logger.log(msg);
  SpreadsheetApp.getUi().alert('Diagnóstico ESTADÍSTICAS', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

/* Mueve el título "INFORMES DEL PERIODO" + su fila de rótulos "FECHA/
 * CLIENTE/..." (2 filas, columnas anchoCol..anchoCol+13 para cubrir de
 * sobra las 10 cabeceras + margen) a justo debajo del bloque KPI (ver
 * EST_YEAR_KPI_TOP), usando Range.moveTo() — corta Y PEGA formato+valores
 * en una sola llamada, sin necesitar clics en la hoja (el intento manual
 * de arrastrar/cortar-pegar estas filas en el navegador no se pudo hacer
 * de forma fiable). Es una operación de UNA VEZ (mueve celdas reales) —
 * no algo que se repita en cada refresco como las demás funciones _est*. */
function moverBloqueInformesDelPeriodo() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }

  var data = sheet.getDataRange().getValues();
  var titleRow = -1, titleCol = -1;
  for (var r = 0; r < data.length - 1 && titleRow === -1; r++) {
    for (var c = 0; c < data[r].length; c++) {
      if (String(data[r][c]).trim().toUpperCase() === 'INFORMES DEL PERIODO') {
        var headerRowValues = data[r + 1];
        for (var c2 = 0; c2 < headerRowValues.length; c2++) {
          if (String(headerRowValues[c2]).trim().toUpperCase() === 'FECHA') {
            titleRow = r + 1; titleCol = c2 + 1; // 1-based; título vive en la MISMA columna que "FECHA"
            break;
          }
        }
      }
    }
  }
  if (titleRow === -1) {
    SpreadsheetApp.getUi().alert('No se encontró "INFORMES DEL PERIODO" con "FECHA" justo debajo — revisa que el título siga escrito tal cual.');
    return;
  }

  var kpiTop = ss.getRangeByName('EST_YEAR_KPI_TOP');
  if (!kpiTop) {
    SpreadsheetApp.getUi().alert('EST_YEAR_KPI_TOP no existe — no se puede calcular una posición segura para mover el bloque.');
    return;
  }
  var kpiLastRow = kpiTop.getRow() + 4;
  var targetTitleRow = kpiLastRow + 2; // 1 fila de margen visual debajo del KPI

  if (targetTitleRow <= titleRow) {
    SpreadsheetApp.getUi().alert('El bloque ya está por debajo del KPI (título en fila ' + titleRow + ', KPI hasta fila ' + kpiLastRow + ') — no hace falta moverlo.');
    return;
  }

  var WIDTH = 14; // cubre de sobra las 10 cabeceras (F..O) + margen
  var source = sheet.getRange(titleRow, titleCol, 2, WIDTH);
  var target = sheet.getRange(targetTitleRow, titleCol, 2, WIDTH);
  source.moveTo(target);

  // El rango con nombre (si ya existía, sano o corrupto) apuntaba a la
  // posición vieja — se borra para que la próxima "Conectar tabla"/
  // "Actualizar fórmulas" lo relocalice por texto, ya en su sitio nuevo.
  if (ss.getRangeByName('EST_INFORMES_TABLE')) ss.removeNamedRange('EST_INFORMES_TABLE');

  SpreadsheetApp.getUi().alert(
    'Bloque movido',
    'Se movió de la fila ' + titleRow + ' a la fila ' + targetTitleRow + ' (columna ' + _estColLetter(titleCol) + ').\n\n' +
    'Ahora ejecuta "🔁 Actualizar fórmulas" (o "🔌 Conectar tabla") para que la tabla se rellene en la nueva posición.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/* Descubierto el 2026-07-27 (varias rondas de mover el bloque a mano y por
 * código dejaron MÁS DE UNA aparición del título "INFORMES DEL PERIODO"
 * en la hoja — F17 y F19 confirmados por el diagnóstico). En vez de
 * seguir intentando localizar "la" ocurrencia correcta, esta función
 * BORRA un bloque generoso (20 filas × 18 columnas) alrededor de CADA
 * aparición encontrada — título, cabecera vieja, cualquier fórmula/dato
 * de un intento anterior — y reconstruye una única copia limpia en la
 * fila 16 (título) / 17 (cabecera), **alineada con "RESULTADOS SEGÚN
 * FILTRO"** (que también tiene título en 16 y cabecera+datos en 17) —
 * pedido explícito del usuario el 2026-07-27. Esto ya NO depende de
 * dónde esté el bloque KPI — ese bloque se mueve a la columna W con
 * `moverBloqueKPI()`, dejando F:S libre para esta tabla. Solo toca las
 * columnas F en adelante — nunca A:E (esa es la otra tabla). Usa toast()
 * en vez de alert() para no dejar un diálogo bloqueante a medio camino
 * si se llama desde repararTodoEstadisticas(). */
function reconstruirInformesDelPeriodoLimpio() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  var WIDTH = 14; // F..S — 10 cabeceras + columna ID oculta + margen; NO llega a T:V (listas ocultas) ni a W (KPI reubicado)
  var startCol = 6; // F, columna donde siempre ha vivido esta sección

  function limpiarOcurrencias() {
    var data = sheet.getDataRange().getValues();
    var any = false;
    for (var r = 0; r < data.length; r++) {
      for (var c = 0; c < data[r].length; c++) {
        if (String(data[r][c]).trim().toUpperCase() === 'INFORMES DEL PERIODO') {
          var zona = sheet.getRange(r + 1, c + 1, 20, WIDTH);
          _estBreakApartOverlapping(sheet, zona);
          zona.clearContent();
          any = true;
        }
      }
    }
    return any;
  }
  // Segunda pasada por si limpiar una ocurrencia desvela otra que la
  // primera lectura no había capturado bien (defensivo, barato de repetir).
  limpiarOcurrencias();
  limpiarOcurrencias();

  if (ss.getRangeByName('EST_INFORMES_TABLE')) ss.removeNamedRange('EST_INFORMES_TABLE');

  var titleRow = 16;
  var headerRow = 17;
  _estSectionHeader(sheet, titleRow, 'INFORMES DEL PERIODO', EST_INFORMES_HEADERS.length, false, startCol);

  var localeOriginal = ss.getSpreadsheetLocale();
  try {
    ss.setSpreadsheetLocale('en_US');
    _estApplyInformesPeriodoFormula(sheet, headerRow, startCol, true); // true = aplica el estilo uniforme (reconstrucción explícita, no un refresco automático)
  } finally {
    ss.setSpreadsheetLocale(localeOriginal);
  }

  ss.toast('"Informes del período" reconstruida, limpia, en la fila ' + titleRow + ' (cabecera en fila ' + headerRow + ').', 'AEDIS', 6);
}

/* Mueve el bloque KPI (Informes aprobados/Trabajadores distintos/
 * Materiales/Trabajo/Total, ancla EST_YEAR_KPI_TOP) a la columna W (23) —
 * pedido explícito del usuario el 2026-07-27: quiere "Informes del
 * período" empezando en la fila 16/17 en columna F, y ese hueco (F:S,
 * hasta donde llega el margen de esa tabla) es justo donde el KPI había
 * terminado cayendo tras varias rondas de reposicionamiento a mano. W
 * queda libre de todo: F:S (informes del período + margen), G:K (RESUMEN
 * GENERAL), T:V (listas ocultas de los desplegables), AB:AF (helper de
 * "Resultados según filtro"). Misma fila, solo cambia de columna. */
/* Descubierto el 2026-07-27 en vivo, segunda vuelta: incluso rompiendo
 * merges en una franja "amplia" adivinada a ojo (8×8) alrededor de una
 * zona, Sheets seguía lanzando "para combinar o separar celdas hay que
 * seleccionar el rango completo" — porque esa franja adivinada tocaba
 * PARCIALMENTE algún merge que se salía por un lado (p.ej. una banda de
 * título ancha de otra sección). breakApart() exige que el rango que le
 * pasas contenga el merge ENTERO, o que no lo toque en absoluto — nunca
 * un solape parcial. Solución correcta, no adivinada: recorre TODOS los
 * merges reales de la hoja y rompe, uno a uno, únicamente los que de
 * verdad se solapan con la zona de interés — cada uno con su propio
 * rango completo (el que ya tiene), así que nunca puede ser "parcial". */
function _estBreakApartOverlapping(sheet, targetRange) {
  var merges = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).getMergedRanges();
  var tRow1 = targetRange.getRow(), tCol1 = targetRange.getColumn();
  var tRow2 = tRow1 + targetRange.getNumRows() - 1, tCol2 = tCol1 + targetRange.getNumColumns() - 1;
  merges.forEach(function (m) {
    var mRow1 = m.getRow(), mCol1 = m.getColumn();
    var mRow2 = mRow1 + m.getNumRows() - 1, mCol2 = mCol1 + m.getNumColumns() - 1;
    var overlap = mRow1 <= tRow2 && tRow1 <= mRow2 && mCol1 <= tCol2 && tCol1 <= mCol2;
    if (overlap) m.breakApart();
  });
}

function moverBloqueKPI() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  var kpiTop = ss.getRangeByName('EST_YEAR_KPI_TOP');
  if (!kpiTop) {
    SpreadsheetApp.getUi().alert('EST_YEAR_KPI_TOP no existe.');
    return;
  }
  var kr = kpiTop.getRow(), kc = kpiTop.getColumn();
  var targetCol = 23; // W
  if (kc === targetCol) {
    ss.toast('El bloque KPI ya está en la columna W — no hace falta moverlo.', 'AEDIS', 5);
    return;
  }
  // Descubierto el 2026-07-27 en vivo: moveTo() fallaba con "no se puede
  // cortar/pegar parte de una celda combinada" — esta zona (maquetada a
  // mano en varias rondas anteriores) tiene algún merge que se sale del
  // rectángulo 5×2 exacto. Abandonado moveTo() por completo: se leen
  // valores Y fórmulas del origen a mano, se rompen (con precisión
  // quirúrgica, ver _estBreakApartOverlapping) los merges reales que
  // solapan origen/destino, se borra el origen y se escribe lo mismo en
  // el destino — mismo resultado que "cortar y pegar" sin pasar por el
  // método de Sheets que se atasca con los merges. getFormulas() devuelve
  // "" en las celdas que NO tienen fórmula (solo un valor literal) — por
  // eso se escriben primero los VALORES con setValues() y las fórmulas
  // se despliegan por encima, celda a celda, solo donde de verdad las había.
  var source = sheet.getRange(kr, kc, 5, 2);
  var values = source.getValues();
  var formulas = source.getFormulas();

  var target = sheet.getRange(kr, targetCol, 5, 2);
  _estBreakApartOverlapping(sheet, source);
  _estBreakApartOverlapping(sheet, target);

  source.clearContent();
  target.setValues(values);
  for (var r = 0; r < formulas.length; r++) {
    for (var c = 0; c < formulas[r].length; c++) {
      if (formulas[r][c]) target.getCell(r + 1, c + 1).setFormula(formulas[r][c]);
    }
  }

  _estSetNamedRange(ss, 'EST_YEAR_KPI_TOP', sheet.getRange(kr, targetCol));
  ss.toast('Bloque KPI movido a la columna W (misma fila, ' + kr + ').', 'AEDIS', 6);
}

/* Pedido explícito 2026-07-27: de las 5 filas del bloque KPI (Informes
 * aprobados/Trabajadores distintos/Materiales/Trabajo/Total), solo las 2
 * primeras se quedan — las otras 3 duplican la fila TOTAL que ya muestra
 * la propia tabla de "RESUMEN GENERAL" (EST_YEAR_TABLE) justo encima, y
 * se borran. Las 2 que quedan se reubican en I12:J13, dentro del propio
 * bloque de RESUMEN GENERAL en vez de aparte. Migración de una sola vez
 * — después de esto, refreshEstadisticasFormulas()/repararTodoEstadisticas()
 * ya solo escriben esas 2 filas (ver el recorte de yearFormulas ahí). */
function reorganizarKPIEnResumenGeneral() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  var kpiTop = ss.getRangeByName('EST_YEAR_KPI_TOP');
  if (!kpiTop) {
    SpreadsheetApp.getUi().alert('EST_YEAR_KPI_TOP no existe.');
    return;
  }
  var kr = kpiTop.getRow(), kc = kpiTop.getColumn();
  var targetRow = 12, targetCol = 9; // I12

  if (kr === targetRow && kc === targetCol) {
    ss.toast('El bloque ya está en I12:J13 — no hace falta reorganizarlo.', 'AEDIS', 5);
    return;
  }

  // Lee las 2 primeras filas (etiqueta+fórmula) ANTES de borrar nada.
  var keep = sheet.getRange(kr, kc, 2, 2);
  var keepValues = keep.getValues();
  var keepFormulas = keep.getFormulas();

  // Borra el bloque de 5 filas ENTERO (las 2 que se quedan se reescriben
  // aparte en su sitio nuevo; las otras 3 no se recrean en ningún sitio).
  var full = sheet.getRange(kr, kc, 5, 2);
  _estBreakApartOverlapping(sheet, full);
  full.clearContent();

  var target = sheet.getRange(targetRow, targetCol, 2, 2);
  _estBreakApartOverlapping(sheet, target);
  target.setValues(keepValues);
  for (var r = 0; r < keepFormulas.length; r++) {
    for (var c = 0; c < keepFormulas[r].length; c++) {
      if (keepFormulas[r][c]) target.getCell(r + 1, c + 1).setFormula(keepFormulas[r][c]);
    }
  }
  sheet.getRange(targetRow, targetCol, 2, 1).setHorizontalAlignment('right');
  sheet.getRange(targetRow, targetCol + 1, 2, 1).setFontWeight('bold').setHorizontalAlignment('right');

  _estSetNamedRange(ss, 'EST_YEAR_KPI_TOP', sheet.getRange(targetRow, targetCol));
  ss.toast('"Informes aprobados"/"Trabajadores distintos" reubicados en I12:J13; Materiales/Trabajo/Total (año) eliminados por duplicados.', 'AEDIS', 8);
}

/* Punto de entrada único pedido explícitamente ("resuélveme todos los
 * problemas de la página"): reconstruye "Informes del período" desde
 * cero en una posición segura (ver arriba) y a continuación reaplica
 * TODO lo demás (tiles, "Resultados según filtro", "RESUMEN GENERAL
 * (año)" + su KPI, formato condicional) vía refreshEstadisticasFormulas()
 * — ese ya es el motor probado para esa parte, no se duplica su lógica
 * aquí. */
function repararTodoEstadisticas() {
  repararListasDesplegables();
  reorganizarKPIEnResumenGeneral();
  reconstruirInformesDelPeriodoLimpio();
  refreshEstadisticasFormulas();
}

/* DIAGNÓSTICO/REPARACIÓN TEMPORAL 2026-07-27 (sexta continuación) —
 * pedido explícito: una sola acción que arregle todo Y muestre el estado
 * REAL resultante en un modal, en vez de tener que comprobar celda a
 * celda a mano. Hace lo mismo que repararTodoEstadisticas() más el
 * reseteo de Desde/Hasta, y termina con un alert() bloqueante que lee
 * las celdas clave DESPUÉS de todo lo demás — así no hay duda de si el
 * problema es de datos o de que la pantalla no se refresca sola. */
function reparacionEmergencia() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  _estAplicarRangoPorDefecto(ss, sheet);
  repararListasDesplegables();
  reorganizarKPIEnResumenGeneral();
  reconstruirInformesDelPeriodoLimpio();
  refreshEstadisticasFormulas();

  var desdeAhora = ss.getRangeByName('EST_DESDE').getValue();
  var hastaAhora = ss.getRangeByName('EST_HASTA').getValue();
  var informesAnchor = _estLocateInformesPeriodoAnchor(sheet);
  var informesEstado = 'NO ENCONTRADA';
  if (informesAnchor) {
    var idCell = sheet.getRange(informesAnchor.row, informesAnchor.col).getValue();
    var fechaHeader = sheet.getRange(informesAnchor.row, informesAnchor.col + 1).getValue();
    var primeraFilaId = sheet.getRange(informesAnchor.row + 1, informesAnchor.col).getValue();
    informesEstado = 'fila ' + informesAnchor.row + ', col ' + _estColLetter(informesAnchor.col) +
      ' — cabecera: "' + idCell + '" / "' + fechaHeader + '" — primera fila de datos ID: "' + primeraFilaId + '"';
  }
  var yearAnchor = ss.getRangeByName('EST_YEAR_TABLE');
  var yearEstado = yearAnchor ? ('fila ' + yearAnchor.getRow() + ', col ' + _estColLetter(yearAnchor.getColumn())) : 'NO ENCONTRADA';

  SpreadsheetApp.getUi().alert(
    'Reparación de emergencia — estado real tras terminar',
    'Desde: ' + desdeAhora + '\nHasta: ' + hastaAhora +
    '\n\nInformes del período: ' + informesEstado +
    '\nRESUMEN GENERAL (año): ' + yearEstado,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/* Lee las celdas de filtro de ESTADÍSTICAS (ver EST_CELLS) y genera el
 * informe con _generateStatReportCore — el mismo motor que usa el wizard
 * "Crear informe" de la app, así que el archivo resultante también queda
 * registrado en INFORMES_GENERADOS y aparece en la lista de la app. No
 * pasa por checkUser(p) (no hay PIN en este contexto: quien ejecuta esto
 * ya es el dueño/editor de la propia spreadsheet). */
function createReportFromSheetFilters() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + ' — ejecuta antes "⚠️ Reconstruir hoja desde cero".');
    return;
  }

  function norm(v) {
    var s = String(v == null ? '' : v).trim();
    return (!s || s === '(Todos)') ? '' : s;
  }
  // Lee por NOMBRE, no por dirección — así funciona igual aunque el
  // usuario haya movido/redimensionado las celdas de filtro.
  function estRange(name) {
    var r = ss.getRangeByName(name);
    if (!r) throw new Error('Falta el rango con nombre "' + name + '" — ejecuta "⚠️ Reconstruir hoja desde cero" para recrearlo.');
    return r;
  }

  var desdeRaw = estRange(EST_CELLS.DESDE).getValue();
  var hastaRaw = estRange(EST_CELLS.HASTA).getValue();
  var p = {
    desde: desdeRaw ? dateKey(desdeRaw) : '',
    hasta: hastaRaw ? dateKey(hastaRaw) : '',
    cliente: norm(estRange(EST_CELLS.CLIENTE).getValue()),
    obra: norm(estRange(EST_CELLS.OBRA).getValue()),
    operario: norm(estRange(EST_CELLS.OPERARIO).getValue()),
    pctMateriales: estRange(EST_CELLS.PCT_MATERIALES).getValue() || 0,
    pctTrabajo: estRange(EST_CELLS.PCT_TRABAJO).getValue() || 0,
    // El campo "Tarifa €/h" del filtro se retiró el 2026-07-27 (continuación)
    // — no servía para nada real (solo afectaba la vista previa del
    // informe exportado, nunca los datos). Sustituido por
    // reemplazarTarifaPeriodo(), que sí escribe en INFORME de verdad. Este
    // informe exportado ya no lleva ningún override de tarifa.
    precioHoraOverride: '',
    formato: String(estRange(EST_CELLS.FORMATO).getValue() || 'pdf').toLowerCase()
  };

  var creadoPor = 'Panel (Hoja de cálculo)';
  try { var email = Session.getActiveUser().getEmail(); if (email) creadoPor = email; } catch (e) {}

  try {
    var result = _generateStatReportCore(p, creadoPor);
    estRange(EST_CELLS.RESULTADO).setValue(result.url);
    ss.toast('Informe generado correctamente.', 'AEDIS', 5);
  } catch (err) {
    estRange(EST_CELLS.RESULTADO).setValue('Error: ' + err.message);
    ss.toast('Error al generar el informe: ' + err.message, 'AEDIS', 8);
  }
}

/* Actualiza SOLO las fórmulas (4 plaquitas, "Resultados según filtro",
 * "RESUMEN GENERAL (año)") — a diferencia de createEstadisticasSheet(),
 * esta función NO borra ni recrea la hoja: no toca colores, anchos de
 * columna, filas/columnas ocultas ni ninguna otra personalización manual.
 * Encuentra cada celda por su RANGO CON NOMBRE (ver EST_CELLS y los
 * nombres EST_TILE_..., EST_FILTRO_TABLE, EST_YEAR_...), así que funciona
 * igual aunque el usuario haya movido o redimensionado esas celdas. Pedido
 * explícito: poder reordenar celdas sin perder el diseño cada vez que
 * hace falta refrescar un cálculo. */
function refreshEstadisticasFormulas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + ' — ejecuta primero "⚠️ Reconstruir hoja desde cero".');
    return;
  }
  function named(name) {
    var r = ss.getRangeByName(name);
    if (!r) throw new Error('Falta el rango con nombre "' + name + '" — ejecuta "⚠️ Reconstruir hoja desde cero" para recrearlo.');
    return r;
  }
  try {
    var localeOriginal = ss.getSpreadsheetLocale();
    try {
      ss.setSpreadsheetLocale('en_US');

      _estComputeTiles(sheet);

      var filtroAnchor = named('EST_FILTRO_TABLE');
      _estApplyFiltroFormulas(sheet, filtroAnchor.getRow(), filtroAnchor.getColumn());

      // "Informes del período" es opcional (hojas creadas antes de esta
      // sección no la tienen) — se localiza por su propio rango con
      // nombre o, la primera vez, por el texto "INFORMES DEL PERIODO" +
      // "FECHA" ya escritos a mano; si no se encuentra nada, se ignora en
      // silencio en vez de romper el resto del refresco. Si colisiona con
      // el bloque KPI de RESUMEN GENERAL (ver _estInformesPeriodoCollision),
      // tampoco se escribe — mejor dejarla intacta que pisar una de las
      // dos secciones sin que el usuario se entere.
      var informesAnchor = _estLocateInformesPeriodoAnchor(sheet);
      if (informesAnchor && !_estInformesPeriodoCollision(ss, informesAnchor.row, informesAnchor.col, EST_INFORMES_HEADERS.length + 4)) {
        _estApplyInformesPeriodoFormula(sheet, informesAnchor.row, informesAnchor.col);
      }

      var yearCrit = 'INFORME!C2:C,">="&DATE(YEAR(TODAY()),1,1),INFORME!C2:C,"<="&DATE(YEAR(TODAY()),12,31)';
      named('EST_YEAR_TITLE').setFormula('="RESUMEN GENERAL ("&YEAR(TODAY())&")"');
      // Ya no es fórmula QUERY — ver _estApplyYearTableFormula (calculado
      // en Apps Script, mismo motivo y mismo patrón que "Resultados según
      // filtro"): permite fijar tamaño/alineación/fusión en la fila TOTAL,
      // cosa que ConditionalFormatRuleBuilder no puede hacer.
      var yearRangeExisting = named('EST_YEAR_TABLE');
      _estApplyYearTableFormula(sheet, yearRangeExisting.getRow(), yearRangeExisting.getColumn());

      // Recortado a 2 filas (Informes aprobados/Trabajadores distintos)
      // el 2026-07-27, pedido explícito: Materiales/Trabajo/Total (año)
      // se quitaron de este bloque por duplicar la fila TOTAL que ya
      // muestra la propia tabla de RESUMEN GENERAL (EST_YEAR_TABLE) justo
      // encima. Ver reorganizarKPIEnResumenGeneral() para la reubicación
      // en I12:J13 (una sola vez).
      var yearKpiTop = named('EST_YEAR_KPI_TOP');
      var kpiRow = yearKpiTop.getRow(), kpiCol = yearKpiTop.getColumn();
      var yearFormulas = [
        '=COUNTIFS(' + yearCrit + ')',
        '=IFERROR(COUNTA(UNIQUE(FILTER(INFORME!F2:F,YEAR(INFORME!C2:C)=YEAR(TODAY()),INFORME!F2:F<>""))),0)'
      ];
      for (var yi = 0; yi < yearFormulas.length; yi++) {
        sheet.getRange(kpiRow + yi, kpiCol + 1).setFormula(yearFormulas[yi]);
      }

      // Las reglas de formato condicional '="TOTAL"' que este script ponía
      // aquí quedaron obsoletas el 2026-07-27 (continuación): tanto
      // "Resultados según filtro" como "RESUMEN GENERAL (año)" ahora
      // aplican su propio estilo de TOTAL directamente en código (ver
      // _estApplyFiltroFormulas/_estApplyYearTableFormula) — más completo
      // (fondo, tamaño, alineación, fusión) de lo que un
      // ConditionalFormatRuleBuilder puede expresar. Se retiran aquí
      // cualquier regla vieja con esa huella que quedara de sesiones
      // anteriores, sin tocar ninguna otra que el usuario haya añadido a
      // mano.
      var ajenas = sheet.getConditionalFormatRules().filter(function (rule) {
        var cond = rule.getBooleanCondition();
        var vals = cond && cond.getCriteriaValues();
        var texto = vals && vals[0] ? String(vals[0]) : '';
        return texto.indexOf('="TOTAL"') === -1; // se conservan las que no son mías
      });
      sheet.setConditionalFormatRules(ajenas);
    } finally {
      ss.setSpreadsheetLocale(localeOriginal);
    }
    ss.toast('Fórmulas actualizadas — tu diseño no se ha tocado.', 'AEDIS', 5);
  } catch (err) {
    SpreadsheetApp.getUi().alert('Error al actualizar fórmulas: ' + err.message);
  }
}

// Escribe una cabecera de sección con la misma banda azul clara usada en
// toda esta hoja — evita repetir el mismo bloque de formato 6 veces.
// isFormula=true trata "text" como fórmula (p.ej. un título con el año
// actual incluido, que se actualiza solo al pasar de año). startCol
// (por defecto 1 = columna A) permite cabeceras que no arrancan en A —
// necesario desde que "RESUMEN GENERAL (año)" vive en la columna G.
function _estSectionHeader(sheet, row, text, numCols, isFormula, startCol) {
  var rng = sheet.getRange(row, startCol || 1, 1, numCols || 7);
  rng.merge();
  if (isFormula) rng.setFormula(text); else rng.setValue(text);
  rng.setFontWeight('bold').setFontSize(13)
     .setBackground('#eaf1fb').setFontColor('#0b3d91').setVerticalAlignment('middle');
  sheet.setRowHeight(row, 28);
}

// Número de columna (1=A, 13=M...) → letra. Necesario porque las
// fórmulas de _estApplyFiltroFormulas() referencian columnas relativas a
// donde esté anclada la tabla (puede haberse movido).
function _estColLetter(n) {
  var s = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* Escribe "Resultados según filtro" — un solo sitio de verdad para que
 * _buildEstadisticasSheetContent (la crea) y refreshEstadisticasFormulas
 * (la reescribe sin borrar la hoja) nunca puedan desincronizarse.
 *
 * Primer intento de esta ronda (descartado): calcular Materiales/Trabajo/
 * Total YA CON el recargo aplicado dentro del propio QUERY, con el % y la
 * tarifa insertados como texto en el "select"/"label". Se rompió en vivo
 * ("Error: revisa los filtros") — lo más probable es que QUERY no sepa
 * emparejar una etiqueta `label` con una columna cuyo valor es una suma
 * de dos subexpresiones distintas (Materiales_con_recargo + Trabajo_con_
 * recargo), a diferencia de una expresión simple como `sum(R)-sum(Q)`
 * (esa sí es y era, ya antes de esta ronda, una columna etiquetable —
 * literalmente la misma que ya funcionaba en la versión sin recargo).
 *
 * Diseño actual (más robusto): QUERY SOLO calcula agregados simples y
 * ETIQUETABLES (sum(Q), sum(R)-sum(Q), sum(L) — el mismo patrón ya
 * probado antes de tocar nada de recargos), volcados a columnas OCULTAS
 * (M:Q, lejos de la tabla visible) junto con una fila TOTAL apilada
 * (mismo truco `{QUERY(...);{"TOTAL",...}}` de siempre). Las columnas
 * VISIBLES (Cliente/Obra/Materiales/Trabajo/Total) son ARRAYFORMULA
 * puras que solo hacen aritmética sobre esas columnas ocultas — ninguna
 * pasa por el lenguaje de QUERY, así que no hay ningún "label" que
 * pueda fallar en emparejar.
 * anchorRow/anchorCol = posición ACTUAL de la columna "Cliente" visible
 * (puede no ser A20 si el usuario movió la tabla). */
// Fragmento WHERE reutilizado por CUALQUIER tabla de esta hoja que deba
// respetar los 5 filtros (fecha+cliente+obra+operario) — antes vivía
// duplicado dentro de _estApplyFiltroFormulas; extraído a función propia
// para que _estApplyInformesPeriodoFormula (tabla "INFORMES DEL PERIODO")
// pueda usar EXACTAMENTE el mismo criterio sin mantener una segunda copia
// que se puede desincronizar.
// Fragmento WHERE para UN filtro que ahora puede llevar varios valores
// separados por comas (pedido explícito 2026-07-27: "разрешить выбирать
// несколько" — multiselección vía el diálogo de `abrirSelectorFiltros`).
// "(Todos)"/vacío sigue significando "sin filtrar". Con 1+ valores,
// separa la celda por comas en la propia fórmula (SPLIT/TRIM) y encadena
// un "or" por cada uno — mismo truco de escapar comillas simples que ya
// usaba la versión de un solo valor (SUBSTITUTE "'"→"\'"), aplicado
// elemento a elemento con ARRAYFORMULA.
function _estMultiClause(cellName, colLetter) {
  return 'IF(OR(' + cellName + '="",' + cellName + '="(Todos)"),"",' +
    '"and (' + colLetter + ' = \'"&TEXTJOIN("\' or ' + colLetter + ' = \'",1,ARRAYFORMULA(SUBSTITUTE(TRIM(SPLIT(' + cellName + ',",")),"\'","\\\'")))&"\') ")';
}

function _estWhereClause() {
  return 'IF(EST_DESDE="","","and C >= date \'"&TEXT(EST_DESDE,"yyyy-mm-dd")&"\' ")' +
    '&IF(EST_HASTA="","","and C <= date \'"&TEXT(EST_HASTA,"yyyy-mm-dd")&"\' ")' +
    '&' + _estMultiClause('EST_CLIENTE', 'D') +
    '&' + _estMultiClause('EST_OBRA', 'E') +
    '&' + _estMultiClause('EST_OPERARIO', 'F');
}

// Misma idea que _estMultiClause pero para uso en Apps Script (JS puro,
// no fórmula de Sheets) — usada por el snapshot editable de "Informes del
// período" y por el selector de filtros. Devuelve null si el filtro es
// "(Todos)"/vacío (sin restricción), o un array de valores seleccionados.
function _estFilterList(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s || s === '(Todos)') return null;
  return s.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}

/* Los 4 indicadores (Trabajadores/Informes/Materiales/Remuneración) —
 * pasaron por DOS diseños antes de este: primero SUMIFS/COUNTIFS con
 * EST_WILDCARD_CRIT (comparación exacta "=", rota en cuanto se
 * selecciona más de un valor), después QUERY con el whereClause de
 * multiselección (que en vivo mostró literalmente "count"/"sum"/
 * "difference(sum sum )" — QUERY sin cláusula "label" genera sola una
 * fila de cabecera con una descripción automática en inglés de la
 * expresión agregada, y esa cabecera resultó ser lo único visible en la
 * celda combinada). Calculado ahora en Apps Script, igual que "Informes
 * del período" y "Resultados según filtro" — mismo criterio de
 * multiselección (_estFilterList), sin QUERY ni ARRAYFORMULA de por
 * medio. Escribe VALORES literales directamente en las celdas de las 4
 * plaquitas; se llama desde refreshEstadisticasFormulas() y desde
 * onEdit() cada vez que cambia un filtro. */
function _estComputeTiles(sheet) {
  var ss = sheet.getParent();
  var desdeVal = ss.getRangeByName('EST_DESDE').getValue();
  var hastaVal = ss.getRangeByName('EST_HASTA').getValue();
  var desdeKey = desdeVal ? dateKey(desdeVal) : '';
  var hastaKey = hastaVal ? dateKey(hastaVal) : '';
  var clienteSel = _estFilterList(ss.getRangeByName('EST_CLIENTE').getValue());
  var obraSel = _estFilterList(ss.getRangeByName('EST_OBRA').getValue());
  var operarioSel = _estFilterList(ss.getRangeByName('EST_OPERARIO').getValue());

  var informeSheet = ss.getSheetByName(SHEET_INFORME);
  var rows = informeSheet ? informeSheet.getDataRange().getValues() : [];
  var informes = 0, materiales = 0, trabajo = 0;
  var trabajadores = {};
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row[INFORME_COL.ID]) continue;
    var cliente = row[INFORME_COL.CLIENTE], obra = row[INFORME_COL.OBRA], operario = row[INFORME_COL.OPERARIO];
    var fechaVal = row[INFORME_COL.FECHA];
    var fechaK = fechaVal ? dateKey(fechaVal) : '';
    if (desdeKey && fechaK < desdeKey) continue;
    if (hastaKey && fechaK > hastaKey) continue;
    if (clienteSel && clienteSel.indexOf(String(cliente)) === -1) continue;
    if (obraSel && obraSel.indexOf(String(obra)) === -1) continue;
    if (operarioSel && operarioSel.indexOf(String(operario)) === -1) continue;

    informes++;
    var precioMat = parseFloat(row[INFORME_COL.PRECIO]) || 0;
    materiales += precioMat;
    trabajo += (parseFloat(row[INFORME_COL.TOTAL]) || 0) - precioMat;
    if (operario) trabajadores[String(operario)] = true;
  }

  var tileTrab = ss.getRangeByName('EST_TILE_TRAB');
  var tileInf = ss.getRangeByName('EST_TILE_INF');
  var tileMat = ss.getRangeByName('EST_TILE_MAT');
  var tileRem = ss.getRangeByName('EST_TILE_REM');
  if (tileTrab) tileTrab.setValue(Object.keys(trabajadores).length);
  if (tileInf) tileInf.setValue(informes);
  if (tileMat) tileMat.setValue(materiales);
  if (tileRem) tileRem.setValue(trabajo);
}

// headerRow/anchorCol: fila y columna de la CABECERA visible (Cliente/
// Obra/Materiales/Trabajo/Total, escrita como texto literal) — mismo
// patrón que _estApplyInformesPeriodoFormula: el rango con nombre
// EST_FILTRO_TABLE apunta a esta fila de cabecera, no a la de datos.
// Antes la cabecera salía del propio "label" de la QUERY oculta y se
// mezclaba con los datos en la misma fila — pedido explícito del usuario
// (2026-07-27): una fila de rótulos fija en la fila 17, datos debajo.
// Esto también evita el bug donde, con 0 filas de resultado, lo único
// visible eran las etiquetas ("Trabajo", "Horas", ...) con pinta de dato.
/* Reescrita por completo el 2026-07-27 de fórmula QUERY/ARRAYFORMULA en
 * vivo a CÁLCULO EN APPS SCRIPT — descubierto en vivo que la versión con
 * fórmulas mostraba "ERR" (todo el IFERROR colapsando) y, en las 4
 * plaquitas, literalmente "count"/"sum"/"difference(sum sum )": las
 * subconsultas QUERY sin cláusula "label" generan solas una fila de
 * cabecera con una descripción automática en inglés de la expresión
 * agregada, y esa cabecera terminaba siendo lo único visible en la celda
 * combinada en vez del número real — un comportamiento de QUERY difícil
 * de prever y, sobre todo, de depurar a distancia sin poder ejecutar la
 * hoja. Mismo cambio de fondo que ya se hizo con "Informes del período":
 * calcular en JS (mismo criterio de multiselección, _estFilterList) y
 * escribir VALORES literales, refrescados por onEdit() cada vez que
 * cambia un filtro — nada de QUERY, nada de ARRAYFORMULA, nada que
 * dependa de cómo Sheets decida etiquetar una columna. */
function _estApplyFiltroFormulas(sheet, headerRow, anchorCol) {
  var ss = sheet.getParent();
  var HEADERS = ['Cliente', 'Obra', 'Materiales', 'Trabajo', 'Total'];
  var CLEAR_ROWS = 300;

  // Mismo motivo de siempre: romper cualquier merge antes de escribir,
  // con precisión quirúrgica (ver _estBreakApartOverlapping).
  _estBreakApartOverlapping(sheet, sheet.getRange(headerRow, anchorCol, CLEAR_ROWS + 1, 5));
  sheet.getRange(headerRow, anchorCol, 1, HEADERS.length).setValues([HEADERS]);

  var dataRow = headerRow + 1;
  var dataArea = sheet.getRange(dataRow, anchorCol, CLEAR_ROWS, 5);
  dataArea.clearContent();
  // BUG REAL encontrado el 2026-07-27 (continuación): clearContent() borra
  // valores pero NO formato — si en un refresco anterior TOTAL cayó en,
  // digamos, la fila 25 (fondo azul + negrita) y ahora, con menos objetos,
  // el conjunto de datos es más corto, esa fila 25 sigue existiendo con el
  // fondo azul de un TOTAL que ya no está ahí — un "fantasma" coloreado.
  // Fix: resetear el formato de TODO el rango reservado (las 300 filas) en
  // cada refresco, antes de volver a aplicar estilo solo a lo que
  // realmente se escribe esta vez.
  dataArea.setBackground(null).setFontWeight('normal').setFontColor('#000000').setFontSize(10);

  var desdeVal = ss.getRangeByName('EST_DESDE').getValue();
  var hastaVal = ss.getRangeByName('EST_HASTA').getValue();
  var desdeKey = desdeVal ? dateKey(desdeVal) : '';
  var hastaKey = hastaVal ? dateKey(hastaVal) : '';
  var clienteSel = _estFilterList(ss.getRangeByName('EST_CLIENTE').getValue());
  var obraSel = _estFilterList(ss.getRangeByName('EST_OBRA').getValue());
  var operarioSel = _estFilterList(ss.getRangeByName('EST_OPERARIO').getValue());
  var pctMat = parseFloat(ss.getRangeByName('EST_PCT_MAT').getValue()) || 0;
  var pctTrab = parseFloat(ss.getRangeByName('EST_PCT_TRAB').getValue()) || 0;

  var informeSheet = ss.getSheetByName(SHEET_INFORME);
  var rows = informeSheet ? informeSheet.getDataRange().getValues() : [];
  var groups = {}; // clave "cliente||obra" -> acumulado en bruto (sin recargo)
  var order = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var cliente = row[INFORME_COL.CLIENTE], obra = row[INFORME_COL.OBRA], operario = row[INFORME_COL.OPERARIO];
    if (cliente === '' && obra === '') continue; // fila sin cliente NI obra — equivalente al "where D is not null" original
    var fechaVal = row[INFORME_COL.FECHA];
    var fechaK = fechaVal ? dateKey(fechaVal) : '';
    if (desdeKey && fechaK < desdeKey) continue;
    if (hastaKey && fechaK > hastaKey) continue;
    if (clienteSel && clienteSel.indexOf(String(cliente)) === -1) continue;
    if (obraSel && obraSel.indexOf(String(obra)) === -1) continue;
    if (operarioSel && operarioSel.indexOf(String(operario)) === -1) continue;

    var key = cliente + '||' + obra;
    if (!groups[key]) {
      groups[key] = { cliente: cliente, obra: obra, materiales: 0, horas: 0, trabajoRaw: 0 };
      order.push(key);
    }
    var precioMat = parseFloat(row[INFORME_COL.PRECIO]) || 0;
    groups[key].materiales += precioMat;
    groups[key].horas += parseFloat(row[INFORME_COL.HORAS]) || 0;
    groups[key].trabajoRaw += (parseFloat(row[INFORME_COL.TOTAL]) || 0) - precioMat;
  }
  order.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); }); // "order by Cliente,Obra"

  var out = [];
  var totMat = 0, totTrab = 0;
  order.forEach(function (key) {
    var g = groups[key];
    var materiales = g.materiales * (1 + pctMat / 100);
    // El override manual de tarifa (antes: campo "Tarifa €/h" del filtro)
    // se retiró el 2026-07-27 (continuación) — siempre se usa la tarifa
    // real de cada informe (PRECIO_HORA en INFORME). Para cambiarla de
    // verdad, ver reemplazarTarifaPeriodo().
    var trabajo = g.trabajoRaw * (1 + pctTrab / 100);
    totMat += materiales;
    totTrab += trabajo;
    out.push([g.cliente, g.obra, materiales, trabajo, materiales + trabajo]);
  });
  out.push(['TOTAL', '', totMat, totTrab, totMat + totTrab]);

  sheet.getRange(dataRow, anchorCol, out.length, 5).setValues(out);
  sheet.getRange(dataRow, anchorCol + 2, CLEAR_ROWS, 3).setNumberFormat('#,##0.00 €');

  // Pedido explícito 2026-07-27 (continuación): "recordar" el estilo de la
  // fila TOTAL (negrita, azul marino, letra más grande, fondo azul pálido
  // — igual que el TOTAL de "RESUMEN GENERAL (año)") — fijado en código en
  // cada refresco, para que siga a la fila TOTAL sea cual sea su posición
  // real (out.length varía con los datos). Las filas normales ya quedaron
  // en blanco/negro planas por el reset de dataArea de más arriba, no hace
  // falta repetirlo aquí.
  var totalRow = dataRow + out.length - 1;
  var totalLabelCell = sheet.getRange(totalRow, anchorCol, 1, 2); // Cliente+Obra
  totalLabelCell.merge().setValue('TOTAL');
  sheet.getRange(totalRow, anchorCol, 1, 5).setBackground('#dbe9ff');
  totalLabelCell.setFontWeight('bold').setFontColor('#0b3d91').setFontSize(16).setHorizontalAlignment('right');
  sheet.getRange(totalRow, anchorCol + 2, 1, 3).setFontWeight('bold').setFontColor('#0b3d91').setFontSize(16).setHorizontalAlignment('right');

  _estSetNamedRange(ss, 'EST_FILTRO_TABLE', sheet.getRange(headerRow, anchorCol));
}

/* "RESUMEN GENERAL (año)" — pedido explícito 2026-07-27 (continuación):
 * mismo estilo dinámico para su fila TOTAL que "Resultados según filtro"
 * (fondo azul, negrita, tamaño 16, alineado a la derecha, celda
 * Cliente+Obra fusionada) — imposible de conseguir con el mecanismo
 * anterior (QUERY en vivo + regla de formato condicional), porque
 * ConditionalFormatRuleBuilder NO permite fijar tamaño de letra,
 * alineación ni fusionar celdas, solo negrita/color/fondo. Reescrita al
 * mismo patrón "calculado en Apps Script" ya usado para "Resultados según
 * filtro"/"Informes del período" — mismo motivo de fondo además: una
 * QUERY sin cláusula label ya demostró en esta hoja que puede filtrar mal
 * en silencio. Filtra solo por año en curso (sin Desde/Hasta/Cliente/
 * Objeto/Trabajador/recargo — a propósito, es el resumen del año
 * completo, no del período elegido en los filtros). */
// BUG REAL encontrado el 2026-07-27 (quinta continuación), en vivo: esta
// tabla vive en columnas G:K, y "INFORMES DEL PERIODO" (F:P) comparte esas
// mismas columnas G:K en filas distintas — con la reserva fija de 60 filas
// de antes, _estApplyYearTableFormula limpiaba/escribía por encima de
// "Informes del período" cada vez que corría DESPUÉS (que es el orden en
// _estRefrescarTodoJS), borrando su mitad izquierda (FECHA/CLIENTE/OBRA/
// OPERARIO) en cada refresco automático — el síntoma reportado ("se
// perdió la mitad de la ventana que muestra los informes"). No es pérdida
// de datos permanente (esa tabla se regenera entera desde INFORME en cada
// refresco), pero había que dejar de pisarla. Devuelve cuántas filas de
// datos (cabecera aparte) puede usar esta tabla sin invadir "Informes del
// período" — null si no hay colisión posible (caben las 60 completas).
function _estYearTableSafeRows(sheet, headerRow, anchorCol, maxRows) {
  var anchor = _estLocateInformesPeriodoAnchor(sheet);
  if (!anchor) return maxRows;
  var numColsInformes = EST_INFORMES_HEADERS.length;
  var colsOverlap = anchorCol <= anchor.col + numColsInformes - 1 && anchor.col <= anchorCol + 4;
  if (!colsOverlap) return maxRows;
  // BUG REAL encontrado el 2026-07-27 (sexta continuación), en vivo: el
  // ancla que devuelve _estLocateInformesPeriodoAnchor apunta a la fila de
  // CABECERA (donde vive "ID"), pero el TÍTULO "INFORMES DEL PERIODO" vive
  // una fila POR ENCIMA de eso (ver reconstruirInformesDelPeriodoLimpio:
  // titleRow = headerRow - 1) — el cálculo anterior solo protegía hasta la
  // fila de cabecera, dejando la fila del título dentro del rango que esta
  // tabla limpia/escribe, borrándola en cada refresco. El límite real que
  // no hay que tocar es titleRow, no headerRow.
  var titleRow = anchor.row - 1;
  if (titleRow <= headerRow) return 0; // "Informes del período" ya está POR ENCIMA — no debería pasar, pero no escribir nada es lo seguro
  return Math.min(maxRows, titleRow - headerRow - 1);
}

function _estApplyYearTableFormula(sheet, headerRow, anchorCol) {
  var ss = sheet.getParent();
  var HEADERS = ['Cliente', 'Obra', 'Materiales', 'Trabajo', 'Total'];
  var MAX_CLEAR_ROWS = 60; // mismo margen que ya reservaba la fórmula QUERY anterior
  var CLEAR_ROWS = _estYearTableSafeRows(sheet, headerRow, anchorCol, MAX_CLEAR_ROWS);

  var currentYear = new Date().getFullYear();
  var informeSheet = ss.getSheetByName(SHEET_INFORME);
  var rows = informeSheet ? informeSheet.getDataRange().getValues() : [];
  var groups = {};
  var order = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var cliente = row[INFORME_COL.CLIENTE], obra = row[INFORME_COL.OBRA];
    if (cliente === '' && obra === '') continue;
    var fechaVal = row[INFORME_COL.FECHA];
    if (!fechaVal || new Date(fechaVal).getFullYear() !== currentYear) continue;

    var key = cliente + '||' + obra;
    if (!groups[key]) {
      groups[key] = { cliente: cliente, obra: obra, materiales: 0, trabajoRaw: 0 };
      order.push(key);
    }
    var precioMat = parseFloat(row[INFORME_COL.PRECIO]) || 0;
    groups[key].materiales += precioMat;
    groups[key].trabajoRaw += (parseFloat(row[INFORME_COL.TOTAL]) || 0) - precioMat;
  }
  order.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });

  var out = [];
  var totMat = 0, totTrab = 0;
  order.forEach(function (key) {
    var g = groups[key];
    totMat += g.materiales;
    totTrab += g.trabajoRaw;
    out.push([g.cliente, g.obra, g.materiales, g.trabajoRaw, g.materiales + g.trabajoRaw]);
  });
  out.push(['TOTAL', '', totMat, totTrab, totMat + totTrab]);

  if (out.length > CLEAR_ROWS) {
    // No cabe ni siquiera el resultado real sin invadir "Informes del
    // período" — mejor dejar la tabla como estaba (no tocar nada) que
    // escribir a medias o pisar la otra sección. Se registra para poder
    // diagnosticarlo si el usuario reporta que este bloque dejó de
    // actualizarse.
    Logger.log('_estApplyYearTableFormula: no hay hueco suficiente (' + CLEAR_ROWS + ' filas) para ' + out.length + ' filas reales sin invadir "Informes del período" — no se ha escrito nada.');
    return;
  }

  _estBreakApartOverlapping(sheet, sheet.getRange(headerRow, anchorCol, CLEAR_ROWS + 1, 5));
  sheet.getRange(headerRow, anchorCol, 1, HEADERS.length).setValues([HEADERS]);

  var dataRow = headerRow + 1;
  var dataArea = sheet.getRange(dataRow, anchorCol, CLEAR_ROWS, 5);
  dataArea.clearContent();
  dataArea.setBackground(null).setFontWeight('normal').setFontColor('#000000').setFontSize(10);

  sheet.getRange(dataRow, anchorCol, out.length, 5).setValues(out);
  sheet.getRange(dataRow, anchorCol + 2, CLEAR_ROWS, 3).setNumberFormat('#,##0.00 €');

  var totalRow = dataRow + out.length - 1;
  var totalLabelCell = sheet.getRange(totalRow, anchorCol, 1, 2);
  totalLabelCell.merge().setValue('TOTAL');
  sheet.getRange(totalRow, anchorCol, 1, 5).setBackground('#dbe9ff');
  totalLabelCell.setFontWeight('bold').setFontColor('#0b3d91').setFontSize(16).setHorizontalAlignment('right');
  sheet.getRange(totalRow, anchorCol + 2, 1, 3).setFontWeight('bold').setFontColor('#0b3d91').setFontSize(16).setHorizontalAlignment('right');

  _estSetNamedRange(ss, 'EST_YEAR_TABLE', sheet.getRange(headerRow, anchorCol));
}

// Cabeceras finales (y orden) de "INFORMES DEL PERIODO" — una fila por
// INFORME dentro del rango de fechas + cliente/objeto/trabajador
// elegidos. Corrige el par OBRA/OPERARIO que había quedado duplicado en
// el maquetado a mano del usuario (F,G,H,I,J,K,L,M,N,O,P,Q con OBRA y
// OPERARIO repetidos en J/K) — confirmado con el usuario que era un
// error de maquetado, no algo querido; el resto de columnas se recorre
// un sitio a la izquierda.
// "ID" añadido delante de FECHA el 2026-07-27 — pedido explícito: visible
// como primera columna (no oculta), no solo como clave interna para la
// sincronización con INFORME.
// "PRECIO (EUR)" renombrada a "MATERIALES (EUR)" el 2026-07-27 (continuación)
// por pedido explícito — puramente cosmético: esta columna sigue siendo
// EST_INFORMES_COL.PRECIO_EUR (índice 9), la sincronización con INFORME en
// onEdit se basa en esa posición, no en el texto de la cabecera.
var EST_INFORMES_HEADERS = ['ID', 'FECHA', 'CLIENTE', 'OBRA', 'OPERARIO', 'TRABAJOS REALIZADOS', 'TIPO DE TRABAJO', 'HORAS', 'PRECIO HORA', 'MATERIALES (EUR)', 'TOTAL'];

/* Localiza dónde vive la tabla "INFORMES DEL PERIODO": primero por su
 * rango con nombre (ya construida antes por esta misma función, en
 * ejecuciones posteriores) y, si no existe aún, buscando el texto literal
 * "INFORMES DEL PERIODO" en toda la hoja (el usuario lo escribió a mano)
 * y localizando "FECHA" en la fila justo debajo para saber en qué
 * columna empieza — mismo espíritu que los rangos con nombre de
 * EST_CELLS: no depender de una dirección fija. Devuelve null si no se
 * encuentra nada (la sección fue borrada) — el llamador debe no hacer
 * nada en ese caso, no inventar una posición. */
function _estLocateInformesPeriodoAnchor(sheet) {
  var ss = sheet.getParent();
  var existing = ss.getRangeByName('EST_INFORMES_TABLE');
  // Bug real encontrado el 2026-07-27 en vivo: el rango con nombre se
  // registraba sobre la fila de DATOS (dataRow = headerRow+1), pero aquí
  // se devolvía como si fuera la fila de CABECERA — cada ejecución volvía
  // a leer esa fila de datos como si fuera la cabecera y escribía la
  // tabla una fila más abajo que la vez anterior, "caminando" hacia abajo
  // sola en cada refresco (confirmado: tras varias ejecuciones el rango
  // apuntaba 7 filas por debajo del título real "INFORMES DEL PERIODO").
  // Verificación de cordura antes de confiar en el rango con nombre: la
  // celda en (existing.getRow(), existing.getColumn()) debe decir
  // literalmente "ID" (primera columna visible desde el 2026-07-27) — si
  // no, se ignora el rango (posiblemente corrupto/desplazado de una
  // versión anterior de este código) y se cae al mismo camino de
  // búsqueda por texto que la primera vez, que sí es fiable porque relee
  // la posición real de "INFORMES DEL PERIODO" cada vez.
  if (existing) {
    var maybeId = String(sheet.getRange(existing.getRow(), existing.getColumn()).getValue()).trim().toUpperCase();
    if (maybeId === 'ID') return { row: existing.getRow(), col: existing.getColumn() };
  }

  var data = sheet.getDataRange().getValues();
  for (var r = 0; r < data.length - 1; r++) {
    for (var c = 0; c < data[r].length; c++) {
      if (String(data[r][c]).trim().toUpperCase() === 'INFORMES DEL PERIODO') {
        var headerRowValues = data[r + 1];
        for (var c2 = 0; c2 < headerRowValues.length; c2++) {
          if (String(headerRowValues[c2]).trim().toUpperCase() === 'FECHA') {
            // -1: desde el 2026-07-27 "ID" va delante de "FECHA" como
            // primera columna visible — el ancla de la tabla (startCol)
            // es la columna de "ID", una a la izquierda de donde se
            // encontró "FECHA".
            return { row: r + 2, col: c2 }; // c2 (sin +1) = índice 0-based de FECHA convertido directamente a la columna 1-based de ID
          }
        }
      }
    }
  }
  return null;
}

/* Escribe la cabecera correcta (deduplicada) y la fórmula QUERY en vivo de
 * "INFORMES DEL PERIODO" — headerRow/startCol es la fila de rótulos de
 * columna (donde vive "FECHA") y la columna donde empieza, encontrados
 * por _estLocateInformesPeriodoAnchor. Antes de escribir, limpia tanto el
 * resto de columnas que pudieran quedar del maquetado duplicado como
 * cualquier dato de ejemplo tecleado a mano debajo — un QUERY que haga de
 * array no puede expandirse sobre celdas no vacías. Registra un rango con
 * nombre sobre la celda de datos para que esta misma función (llamada de
 * nuevo desde refreshEstadisticasFormulas) siempre la vuelva a encontrar
 * aunque el usuario mueva la sección entera más adelante. */
// Índice (0-based, dentro de EST_INFORMES_HEADERS) de HORAS/PRECIO HORA —
// las 2 únicas columnas editables a mano con sincronización hacia
// INFORME (ver onEdit). Centralizado aquí para que onEdit y esta función
// nunca puedan desincronizarse sobre qué columna es cuál.
var EST_INFORMES_COL = { HORAS: 7, PRECIO_HORA: 8, PRECIO_EUR: 9, TOTAL: 10 };

/* Reescrita el 2026-07-27 de fórmula QUERY en vivo a INSTANTÁNEA de
 * valores literales — pedido explícito: HORAS/PRECIO HORA deben poder
 * editarse a mano en esta tabla y sincronizarse con INFORME (ver onEdit
 * más abajo). Una celda con fórmula no se puede sobreescribir a mano en
 * Sheets sin romper la fórmula, así que la tabla dejó de ser "viva" en el
 * sentido de recalcularse sola — "viva" ahora significa que onEdit() la
 * mantiene sincronizada en las dos direcciones: cambiar un filtro
 * relanza esta función (recalcula qué filas tocan), y editar HORAS/
 * PRECIO HORA aquí escribe de vuelta en INFORME (y de ahí a PARTE DE
 * TRABAJO, igual que ya hacía la edición directa en INFORME).
 * "ID" es la primera columna VISIBLE (pedido explícito, no oculta) — es
 * la clave que onEdit usa para saber a qué fila de INFORME corresponde
 * una fila editada aquí. Texto sin ajuste de línea y alineado a la
 * izquierda (pedido: "mismo aspecto que en INFORME") en vez del wrap por
 * defecto que dejaba TRABAJOS/TIPO con pinta de texto cortado a trozos. */
function _estApplyInformesPeriodoFormula(sheet, headerRow, startCol, applyUniformStyle) {
  var ss = sheet.getParent();
  var n = EST_INFORMES_HEADERS.length; // 11: ID..TOTAL
  var TRAILING_BUFFER = 3;

  // Mismo motivo que siempre: romper cualquier merge antes de escribir,
  // porque setValues()/setFormula() ignoran en silencio la celda "tapada"
  // de un merge en vez de dar error. Con precisión quirúrgica (ver
  // _estBreakApartOverlapping) para no chocar con un merge ajeno que solo
  // toque una parte de este rango.
  _estBreakApartOverlapping(sheet, sheet.getRange(headerRow, startCol, 301, n + TRAILING_BUFFER));

  sheet.getRange(headerRow, startCol, 1, n).setValues([EST_INFORMES_HEADERS]);
  sheet.getRange(headerRow, startCol + n, 1, TRAILING_BUFFER).clearContent();

  var dataRow = headerRow + 1;
  var CLEAR_ROWS = 300;
  sheet.getRange(dataRow, startCol, CLEAR_ROWS, n + TRAILING_BUFFER).clearContent();

  // --- Filtra INFORME en el propio Apps Script (ya no es QUERY en vivo) ---
  var desdeVal = ss.getRangeByName('EST_DESDE').getValue();
  var hastaVal = ss.getRangeByName('EST_HASTA').getValue();
  var desdeKey = desdeVal ? dateKey(desdeVal) : '';
  var hastaKey = hastaVal ? dateKey(hastaVal) : '';
  var clienteSel = _estFilterList(ss.getRangeByName('EST_CLIENTE').getValue());
  var obraSel = _estFilterList(ss.getRangeByName('EST_OBRA').getValue());
  var operarioSel = _estFilterList(ss.getRangeByName('EST_OPERARIO').getValue());

  var informeSheet = ss.getSheetByName(SHEET_INFORME);
  var rows = informeSheet ? informeSheet.getDataRange().getValues() : [];
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var id = row[INFORME_COL.ID];
    if (!id) continue;
    var cliente = row[INFORME_COL.CLIENTE], obra = row[INFORME_COL.OBRA], operario = row[INFORME_COL.OPERARIO];
    var fechaVal = row[INFORME_COL.FECHA];
    var fechaK = fechaVal ? dateKey(fechaVal) : '';
    if (desdeKey && fechaK < desdeKey) continue;
    if (hastaKey && fechaK > hastaKey) continue;
    if (clienteSel && clienteSel.indexOf(String(cliente)) === -1) continue;
    if (obraSel && obraSel.indexOf(String(obra)) === -1) continue;
    if (operarioSel && operarioSel.indexOf(String(operario)) === -1) continue;

    out.push([
      String(id), fechaVal, cliente, obra, operario,
      row[INFORME_COL.TRABAJOS], row[INFORME_COL.TIPO], row[INFORME_COL.HORAS],
      row[INFORME_COL.PRECIO_HORA], row[INFORME_COL.PRECIO], row[INFORME_COL.TOTAL]
    ]);
  }
  out.sort(function (a, b) {
    var ak = a[1] ? dateKey(a[1]) : '', bk = b[1] ? dateKey(b[1]) : '';
    return ak < bk ? -1 : (ak > bk ? 1 : 0);
  });

  if (out.length > 0) {
    sheet.getRange(dataRow, startCol, out.length, n).setValues(out);
  }

  sheet.getRange(dataRow, startCol, CLEAR_ROWS, n).setWrap(false);
  sheet.getRange(dataRow, startCol, CLEAR_ROWS, 2).setHorizontalAlignment('left');  // ID, Fecha
  sheet.getRange(dataRow, startCol + 1, CLEAR_ROWS, 1).setNumberFormat('dd.mm.yyyy'); // Fecha
  sheet.getRange(dataRow, startCol + EST_INFORMES_COL.HORAS, CLEAR_ROWS, 1).setNumberFormat('0.##');
  sheet.getRange(dataRow, startCol + EST_INFORMES_COL.PRECIO_HORA, CLEAR_ROWS, 3).setNumberFormat('#,##0.00 €'); // Precio hora, Precio (EUR), Total

  // Estilo uniforme — SOLO cuando se pide explícitamente (applyUniformStyle
  // truthy), no en cada refresco automático. Descubierto el 2026-07-27:
  // esta función se llama en cada cambio de filtro (onEdit) — si el
  // fondo/fuente se reseteara aquí siempre, cualquier color o estilo que
  // el usuario pusiera a mano se borraría solo la próxima vez que tocara
  // un filtro. Ahora es una acción de una sola vez (ver
  // reconstruirInformesDelPeriodoLimpio) — después de aplicarlo, el
  // usuario puede recolorear lo que quiera y los refrescos normales
  // (solo texto/números, nunca formato) lo respetan.
  if (applyUniformStyle) {
    sheet.getRange(dataRow, startCol, CLEAR_ROWS, n)
      .setBackground(null).setFontColor('#000000').setFontFamily('Arial').setFontSize(10).setFontWeight('normal');
    if (out.length > 0) {
      sheet.getRange(dataRow, startCol, out.length, n)
        .setBorder(true, true, true, true, true, true, '#d9d9d9', SpreadsheetApp.BorderStyle.SOLID);
    }
  }

  // Ancla el rango con nombre en la fila de CABECERA (headerRow), no en
  // dataRow — ver el comentario de _estLocateInformesPeriodoAnchor arriba
  // para el bug real que causaba esto al revés.
  _estSetNamedRange(ss, 'EST_INFORMES_TABLE', sheet.getRange(headerRow, startCol));
}

/* Descubierto el 2026-07-27 en vivo: el bloque de 5 filas "Informes
 * aprobados/Trabajadores distintos/Materiales/Trabajo/Total" (ancla
 * EST_YEAR_KPI_TOP, 2 columnas: etiqueta+valor) llevaba tantas rondas de
 * reposicionamiento a mano en sesiones anteriores que terminó cayendo
 * justo dentro del hueco de filas/columnas que el usuario reservó para su
 * nueva tabla "INFORMES DEL PERIODO" — al escribir esta última se pisaban
 * mutuamente en silencio (sin error, "gana" quien escribe último). Antes
 * de tocar nada, se comprueba si el rectángulo que se va a escribir
 * (cabecera + las 300 filas de datos reservadas) se solapa con esas 5
 * filas × 2 columnas; si es así, se aborta con un aviso claro en vez de
 * seguir escribiendo encima. */
function _estInformesPeriodoCollision(ss, headerRow, startCol, numCols) {
  var kpiTop = ss.getRangeByName('EST_YEAR_KPI_TOP');
  if (!kpiTop) return null;
  var kr = kpiTop.getRow(), kc = kpiTop.getColumn();
  var rowsOverlap = headerRow <= kr + 4 && kr <= headerRow + 300;
  var colsOverlap = startCol <= kc + 1 && kc <= startCol + numCols - 1;
  if (!rowsOverlap || !colsOverlap) return null;
  return 'El bloque "Informes aprobados/Trabajadores distintos/Materiales/Trabajo/Total" ocupa ' +
    _estColLetter(kc) + kr + ':' + _estColLetter(kc + 1) + (kr + 4) +
    ' — se solapa con donde tendría que escribirse "INFORMES DEL PERIODO" (desde ' +
    _estColLetter(startCol) + headerRow + '). Mueve uno de los dos bloques a otras filas/columnas y vuelve a intentarlo — no se ha escrito nada.';
}

/* Punto de entrada único: localiza + (re)aplica la tabla "INFORMES DEL
 * PERIODO" sin tocar nada más de la hoja. Seguro de llamar aunque la
 * sección no exista todavía en una hoja antigua (no hace nada) — pensado
 * para reutilizarse tanto desde el menú AEDIS como desde
 * refreshEstadisticasFormulas(). */
function implementarInformesDelPeriodo() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  var anchor = _estLocateInformesPeriodoAnchor(sheet);
  if (!anchor) {
    SpreadsheetApp.getUi().alert('No se encontró la sección "INFORMES DEL PERIODO" (con su fila "FECHA" justo debajo) en la hoja — revisa que el título siga escrito tal cual.');
    return;
  }
  var collision = _estInformesPeriodoCollision(ss, anchor.row, anchor.col, EST_INFORMES_HEADERS.length + 4);
  if (collision) {
    SpreadsheetApp.getUi().alert('No se pudo conectar "Informes del período"', collision, SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  var localeOriginal = ss.getSpreadsheetLocale();
  try {
    ss.setSpreadsheetLocale('en_US');
    _estApplyInformesPeriodoFormula(sheet, anchor.row, anchor.col, true); // acción manual explícita — sí aplica el estilo uniforme
  } finally {
    ss.setSpreadsheetLocale(localeOriginal);
  }
  ss.toast('Tabla "Informes del período" conectada — se actualiza sola con los filtros.', 'AEDIS', 5);
}

/* Único punto de refresco para los 3 bloques que ahora se calculan en
 * Apps Script en vez de con fórmula (tiles, "Resultados según filtro",
 * "Informes del período") — usado desde onEdit() al cambiar un filtro,
 * desde onOpen() (pedido explícito 2026-07-27: Desde/Hasta son fórmulas
 * basadas en HOY() que cambian solas cada día sin que eso cuente como
 * una "edición", así que sin esto, recargar la hoja podía dejar estos 3
 * bloques mostrando datos de un rango de fechas que ya no es el que se
 * ve en los filtros) y desde establecerRangoPorDefecto(). */
function _estRefrescarTodoJS(sheet) {
  var ss = sheet.getParent();
  _estComputeTiles(sheet);

  var filtroAnchor = ss.getRangeByName('EST_FILTRO_TABLE');
  if (filtroAnchor) _estApplyFiltroFormulas(sheet, filtroAnchor.getRow(), filtroAnchor.getColumn());

  var anchor = _estLocateInformesPeriodoAnchor(sheet);
  if (anchor && !_estInformesPeriodoCollision(ss, anchor.row, anchor.col, EST_INFORMES_HEADERS.length + 4)) {
    _estApplyInformesPeriodoFormula(sheet, anchor.row, anchor.col);
  }

  var yearAnchor = ss.getRangeByName('EST_YEAR_TABLE');
  if (yearAnchor) _estApplyYearTableFormula(sheet, yearAnchor.getRow(), yearAnchor.getColumn());
}

/* Restablece Desde/Hasta a sus fórmulas por defecto (1 de este mes →
 * HOY) — pedido explícito 2026-07-27. Hace falta como función aparte
 * porque, en el uso normal, esas celdas se acaban sobreescribiendo con
 * una fecha concreta tecleada a mano (dejan de ser fórmula); esto las
 * devuelve a "seguir la fecha de hoy solas" sin reconstruir toda la hoja. */
// Extraído el 2026-07-27 (continuación) de establecerRangoPorDefecto() para
// poder llamarlo también desde onOpen() en silencio (sin toast) cada vez
// que se abre/recarga la hoja — pedido explícito: Desde/Hasta deben volver
// solos a "1 de este mes → hoy" en cada apertura, no solo cuando se pulsa
// el menú a mano.
// BUG REAL encontrado el 2026-07-27 (segunda continuación): la primera
// versión de esto escribía FÓRMULAS (`=DATE(...)`/`=TODAY()`), lo que
// obligaba a cambiar el locale de la hoja a en_US y luego devolverlo — dos
// cambios de locale en CADA apertura. Cambiar el locale de una spreadsheet
// por script fuerza a los clientes abiertos a recargar para reflejarlo, así
// que meter esto dentro de onOpen() creaba un bucle: abrir → onOpen →
// cambia locale ×2 → el cliente se recarga → onOpen vuelve a correr →
// cambia locale ×2 → recarga… ("la página se actualiza sola sin parar",
// confirmado en vivo por el usuario). Arreglado escribiendo VALORES de
// fecha literales (objetos Date de JS) en vez de texto de fórmula — un
// Date no depende del locale para nada, así que no hace falta tocar
// setSpreadsheetLocale aquí. Coste real: Desde/Hasta dejan de
// "autoseguir" el día en vivo dentro de una misma sesión ya abierta (antes
// tampoco se enteraba nadie de ese cambio silencioso sin recargar, así que
// no es una regresión práctica) — se recalculan de nuevo, frescos, en la
// SIGUIENTE apertura, que es exactamente para lo que existe esta función.
function _estAplicarRangoPorDefecto(ss, sheet) {
  var desde = ss.getRangeByName('EST_DESDE');
  var hasta = ss.getRangeByName('EST_HASTA');
  var hoy = new Date();
  // BUG REAL encontrado el 2026-07-28 (reportado por el usuario: "Desde
  // sale con el último día del mes anterior en vez del primero de este
  // mes"): `new Date(year, month, 1)` construye medianoche en el
  // TIMEZONE DE EJECUCIÓN DEL SCRIPT (Extensiones ▸ Apps Script ▸
  // Configuración del proyecto ▸ Zona horaria), no en el de esta hoja de
  // cálculo (ss.getSpreadsheetTimeZone()). Si la hoja va "por detrás"
  // del script aunque sea 1 hora, esa medianoche cae la noche anterior
  // en el timezone de la hoja, y Sheets muestra el día equivocado — sin
  // ningún error, solo la fecha mal. Fix real: sacar año/mes del
  // timezone DE LA HOJA (no del script) con Utilities.formatDate, y
  // reconstruir la fecha con Utilities.parseDate especificando ESE MISMO
  // timezone explícitamente — así el resultado es correcto sin importar
  // qué timezone tenga configurado el script. A las 00:00:01 (un segundo
  // después de medianoche, pedido explícito) en vez de las 00:00:00
  // exactas, como margen adicional.
  var tz = ss.getSpreadsheetTimeZone();
  var anioMes = Utilities.formatDate(hoy, tz, 'yyyy-MM');
  var primerDiaMes = Utilities.parseDate(anioMes + '-01 00:00:01', tz, 'yyyy-MM-dd HH:mm:ss');
  if (desde) desde.setValue(primerDiaMes).setNumberFormat('dd.mm.yyyy');
  if (hasta) hasta.setValue(hoy).setNumberFormat('dd.mm.yyyy');
}

function establecerRangoPorDefecto() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  _estAplicarRangoPorDefecto(ss, sheet);
  _estRefrescarTodoJS(sheet);
  // DIAGNÓSTICO TEMPORAL 2026-07-27 (sexta continuación) — alert() en vez
  // de toast() a propósito: un modal bloqueante es imposible de no ver,
  // a diferencia del toast (que puede desaparecer antes de que el usuario
  // mire) — y muestra el valor RECIÉN LEÍDO de A5/B5, no lo que el
  // usuario cree recordar de la pantalla.
  var desdeAhora = ss.getRangeByName('EST_DESDE').getValue();
  var hastaAhora = ss.getRangeByName('EST_HASTA').getValue();
  SpreadsheetApp.getUi().alert(
    'Desde/Hasta restablecidos',
    'Desde ahora mismo: ' + desdeAhora + '\nHasta ahora mismo: ' + hastaAhora,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/* Pedido explícito 2026-07-27 (continuación): el campo "Tarifa €/h" del
 * filtro de ESTADÍSTICAS se retiró — nunca tocaba datos reales, solo la
 * vista previa del informe exportado. Esto es su reemplazo de verdad:
 * reescribe PRECIO_HORA (y TOTAL, que depende de él: TOTAL = HORAS ×
 * PRECIO_HORA + PRECIO materiales, ver INFORME_COL) en INFORME para TODOS
 * los informes aprobados cuya FECHA cae dentro de [desdeKey, hastaKey]
 * (formato 'yyyy-MM-dd', ver dateKey) — clave vacía = sin límite por ese
 * lado. No toca PRECIO (materiales) ni ningún otro campo. Es la única
 * fuente de verdad para este dato — tanto la hoja (reemplazarTarifaPeriodo,
 * más abajo) como la app (acción 'replaceHourlyRate' en doPost) llaman a
 * este mismo núcleo, así que nunca hay dos lógicas que puedan divergir.
 * Lee/escribe las columnas PRECIO_HORA y TOTAL en dos pasadas por lotes
 * (getValues/setValues sobre el rango completo) en vez de celda a celda,
 * para que no sea lento con muchas filas. Devuelve cuántas filas se
 * tocaron. */
function _reemplazarTarifaPeriodoCore(desdeKey, hastaKey, nuevaTarifa) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetI = ss.getSheetByName(SHEET_INFORME);
  if (!sheetI) throw new Error('No existe la hoja ' + SHEET_INFORME + '.');
  var lastRow = sheetI.getLastRow();
  if (lastRow < 2) return 0;

  var allData = sheetI.getDataRange().getValues();
  var precioHoraCol = INFORME_COL.PRECIO_HORA + 1;
  var totalCol = INFORME_COL.TOTAL + 1;
  var precioHoraVals = sheetI.getRange(2, precioHoraCol, lastRow - 1, 1).getValues();
  var totalVals = sheetI.getRange(2, totalCol, lastRow - 1, 1).getValues();

  var updated = 0;
  var affectedIds = [];
  for (var i = 1; i < allData.length; i++) {
    var row = allData[i];
    var fechaVal = row[INFORME_COL.FECHA];
    if (!fechaVal) continue;
    var fechaK = dateKey(fechaVal);
    if (desdeKey && fechaK < desdeKey) continue;
    if (hastaKey && fechaK > hastaKey) continue;
    var horas = parseFloat(row[INFORME_COL.HORAS]) || 0;
    var precioMateriales = parseFloat(row[INFORME_COL.PRECIO]) || 0;
    precioHoraVals[i - 1][0] = nuevaTarifa;
    totalVals[i - 1][0] = horas * nuevaTarifa + precioMateriales;
    updated++;
    affectedIds.push(row[INFORME_COL.ID]);
  }
  if (updated > 0) {
    sheetI.getRange(2, precioHoraCol, lastRow - 1, 1).setValues(precioHoraVals);
    sheetI.getRange(2, totalCol, lastRow - 1, 1).setValues(totalVals);
  }
  return { updated: updated, ids: affectedIds };
}

/* Punto de entrada desde el menú AEDIS de la hoja — usa el propio Desde/
 * Hasta de los filtros de ESTADÍSTICAS como periodo (pedido explícito, no
 * pide fechas aparte). ui.prompt()/ui.alert() hacen de "ventana" que pide
 * la nueva tarifa y confirma antes de tocar nada, con el recuento real de
 * filas afectadas mostrado tras aplicar — no hay deshacer automático, así
 * que la confirmación es explícita. */
function reemplazarTarifaPeriodo() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  var ui = SpreadsheetApp.getUi();
  if (!sheet) { ui.alert('No existe la hoja ' + EST_SHEET_NAME + '.'); return; }

  var desdeR = ss.getRangeByName('EST_DESDE'), hastaR = ss.getRangeByName('EST_HASTA');
  var desdeVal = desdeR ? desdeR.getValue() : null;
  var hastaVal = hastaR ? hastaR.getValue() : null;
  var desdeKey = desdeVal ? dateKey(desdeVal) : '';
  var hastaKey = hastaVal ? dateKey(hastaVal) : '';
  if (!desdeKey || !hastaKey) {
    ui.alert('Rellena Desde y Hasta en los filtros de ESTADÍSTICAS antes de usar esta acción.');
    return;
  }
  var tz = ss.getSpreadsheetTimeZone();
  var desdeTxt = Utilities.formatDate(desdeVal, tz, 'dd.MM.yyyy');
  var hastaTxt = Utilities.formatDate(hastaVal, tz, 'dd.MM.yyyy');

  var resp = ui.prompt(
    'Reemplazar tarifa del periodo actual',
    'Periodo (según Desde/Hasta de los filtros): ' + desdeTxt + ' – ' + hastaTxt +
    '\n\nNueva tarifa (€/h) para TODOS los informes aprobados en ese periodo:',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var nuevaTarifa = parseFloat(String(resp.getResponseText()).trim().replace(',', '.'));
  if (isNaN(nuevaTarifa) || nuevaTarifa <= 0) {
    ui.alert('Valor no válido — introduce un número mayor que 0.');
    return;
  }

  var confirm = ui.alert(
    'Confirmar',
    'Se va a poner PRECIO_HORA = ' + nuevaTarifa + ' €/h en TODOS los informes aprobados entre ' +
    desdeTxt + ' y ' + hastaTxt + ', y se recalculará su TOTAL (HORAS × tarifa + materiales). ' +
    'Esto sobrescribe el dato actual y no se puede deshacer automáticamente. ¿Continuar?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var result = _reemplazarTarifaPeriodoCore(desdeKey, hastaKey, nuevaTarifa);
  _estRefrescarTodoJS(sheet);
  ss.toast(result.updated + ' informe(s) actualizado(s) a ' + nuevaTarifa + ' €/h.', 'AEDIS', 6);
  if (result.updated > 0) {
    notifyAdminsTarifaCambiada(result.ids.map(function(id){ return { id: id, campo: 'tarifa', valor: nuevaTarifa }; }), null);
  }
}

/* Punto de entrada desde la APP (doPost, acción 'replaceHourlyRate') —
 * mismo núcleo que el menú de la hoja, gateado por PIN + rol (solo
 * admin/manager, igual que el resto de acciones administrativas). p:
 * {codigo, desde, hasta, tarifa} — desde/hasta como 'yyyy-MM-dd' (o
 * cualquier formato que Date() entienda, se normalizan con dateKey). */
function replaceHourlyRate(p) {
  var auth = checkUser(p);
  if (!auth.valid) return { status: 'error', message: 'PIN no válido' };
  if (auth.rol !== 'admin' && auth.rol !== 'manager') {
    return { status: 'error', message: 'No autorizado' };
  }
  var nuevaTarifa = parseFloat(p.tarifa);
  if (isNaN(nuevaTarifa) || nuevaTarifa <= 0) {
    return { status: 'error', message: 'Tarifa no válida' };
  }
  var desdeKey = p.desde ? dateKey(p.desde) : '';
  var hastaKey = p.hasta ? dateKey(p.hasta) : '';
  if (!desdeKey || !hastaKey) {
    return { status: 'error', message: 'Falta el periodo (desde/hasta)' };
  }
  var result = _reemplazarTarifaPeriodoCore(desdeKey, hastaKey, nuevaTarifa);
  // La hoja ESTADÍSTICAS puede estar abierta en otra pestaña mostrando
  // datos ahora desactualizados de este mismo periodo — se refresca
  // igual que hace onEdit() cuando cambia un filtro, por si acaso.
  try {
    var sheetEst = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EST_SHEET_NAME);
    if (sheetEst) _estRefrescarTodoJS(sheetEst);
  } catch (err) { /* no crítico si falla — la próxima apertura/edición la recalcula igual */ }
  if (result.updated > 0) {
    notifyAdminsTarifaCambiada(result.ids.map(function(id){ return { id: id, campo: 'tarifa', valor: nuevaTarifa }; }), { nombre: auth.nombre, rol: auth.rol });
  }
  return { status: 'ok', updated: result.updated };
}

/* Descubierto el 2026-07-27 en vivo, vía debugEstadisticasLayout: las
 * columnas ocultas T/U/V (listas fuente de los desplegables de Cliente/
 * Objeto/Trabajador) estaban COMPLETAMENTE VACÍAS — ni fórmula ni valor,
 * ni siquiera "(Todos)" en T1/U1/V1. Por eso el desplegable mostraba la
 * flecha pero la lista salía vacía: no es un problema del propio
 * desplegable ni de configurarFiltrosMultiseleccion(), sino de que su
 * rango de origen (T1:T500 etc.) no tenía nada que listar. No se sabe
 * con certeza en qué momento se perdieron (probablemente una fusión de
 * celdas de alguna ronda de maquetado a mano de sesiones anteriores se
 * las tragó) — el arreglo, sea cual sea la causa, es el mismo:
 * reescribirlas tal cual las creó _buildEstadisticasSheetContent()
 * originalmente. Rompe cualquier merge que pueda estar tapando estas
 * celdas antes de escribir, mismo motivo de siempre. */
function repararListasDesplegables() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  _estBreakApartOverlapping(sheet, sheet.getRange(1, 20, 500, 3)); // T:V

  var localeOriginal = ss.getSpreadsheetLocale();
  try {
    ss.setSpreadsheetLocale('en_US');
    sheet.getRange('T1').setValue('(Todos)');
    sheet.getRange('T2').setFormula('=SORT(UNIQUE(FILTER({servicio!A2:A;INFORME!D2:D},{servicio!A2:A;INFORME!D2:D}<>"")))');
    sheet.getRange('U1').setValue('(Todos)');
    sheet.getRange('U2').setFormula('=SORT(UNIQUE(FILTER({servicio!B2:B;INFORME!E2:E},{servicio!B2:B;INFORME!E2:E}<>"")))');
    sheet.getRange('V1').setValue('(Todos)');
    sheet.getRange('V2').setFormula('=SORT(UNIQUE(FILTER({servicio!C2:C;servicio!D2:D},{servicio!C2:C;servicio!D2:D}<>"")))');
  } finally {
    ss.setSpreadsheetLocale(localeOriginal);
  }
  ss.toast('Listas de Cliente/Objeto/Trabajador reconstruidas — vuelve a abrir el desplegable.', 'AEDIS', 6);
}

// Multiselección de Cliente/Objeto/Trabajador: retirado el hack propio
// (toggle por celda + setAllowInvalid(true), ver historial en CLAUDE.md si
// hace falta) el 2026-07-27 (continuación) — Google Sheets añadió en
// agosto de 2024 selección múltiple NATIVA de verdad para desplegables
// "Chip" (casillas reales, sin script), que además escribe los valores
// elegidos exactamente en el mismo formato "A, B" que ya esperaba
// _estFilterList() en todo este archivo — no hace falta ningún cambio de
// lectura, solo dejar de "ayudar" con el toggle manual, que ahora
// estorbaría (recibiría el valor YA combinado en vez de una sola opción
// recién elegida). Activar en Datos ▸ Validación de datos ▸ estilo de
// visualización "Chip" ▸ "Permitir varias selecciones", a mano, en B7/B8/B9
// — no es configurable por Apps Script todavía (DataValidationBuilder no
// expone ese criterio).

/* Diálogo modal con casillas — pedido explícito 2026-07-27 ("всплывающее
 * окно с галочками"). Todo el HTML/JS va inline (HtmlService.createHtmlOutput
 * con un string), sin fichero .html aparte, para no depender de que el
 * usuario cree un segundo archivo en el proyecto de Apps Script al pegar
 * este código — ya ha costado bastante que el archivo PRINCIPAL llegue
 * completo. */
function abrirSelectorFiltros() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }

  function listFrom(col) {
    var values = sheet.getRange(col + '2:' + col + '500').getValues();
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var v = String(values[i][0]).trim();
      if (v && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }
  function currentSelection(namedRangeName) {
    var r = ss.getRangeByName(namedRangeName);
    if (!r) return [];
    return _estFilterList(r.getValue()) || [];
  }

  var clientes = listFrom('T'), objetos = listFrom('U'), trabajadores = listFrom('V');
  var selCliente = currentSelection('EST_CLIENTE'), selObjeto = currentSelection('EST_OBRA'), selTrabajador = currentSelection('EST_OPERARIO');

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  function buildSection(title, key, options, selected) {
    var allChecked = selected.length === 0; // vacío/"(Todos)" = todo marcado
    var html = '<div class="sec"><div class="sec-title">' + esc(title) +
      ' <label class="all"><input type="checkbox" class="allbox" data-key="' + key + '"' + (allChecked ? ' checked' : '') + '> (Todos)</label></div>';
    options.forEach(function (opt) {
      var checked = allChecked || selected.indexOf(opt) !== -1;
      html += '<label class="opt"><input type="checkbox" class="itembox" data-key="' + key + '" value="' +
        esc(opt) + '"' + (checked ? ' checked' : '') + '> ' + esc(opt) + '</label>';
    });
    html += '</div>';
    return html;
  }

  var htmlBody =
    '<style>' +
    'body{font-family:Arial,sans-serif;font-size:13px;margin:0;padding:12px;}' +
    '.sec{margin-bottom:14px;max-height:150px;overflow-y:auto;border:1px solid #e0e0e0;border-radius:6px;padding:8px;}' +
    '.sec-title{font-weight:bold;margin-bottom:6px;position:sticky;top:-8px;background:#fff;}' +
    '.sec-title .all{font-weight:normal;float:right;}' +
    '.opt{display:block;padding:2px 0 2px 8px;}' +
    '.footer{margin-top:10px;text-align:right;}' +
    'button{padding:6px 14px;margin-left:6px;}' +
    '</style>' +
    '<div id="root">' +
    buildSection('Cliente', 'cliente', clientes, selCliente) +
    buildSection('Objeto', 'objeto', objetos, selObjeto) +
    buildSection('Trabajador', 'trabajador', trabajadores, selTrabajador) +
    '</div>' +
    '<div class="footer">' +
    '<button onclick="google.script.host.close()">Cancelar</button>' +
    '<button onclick="aplicar()">Aplicar</button>' +
    '</div>' +
    '<script>' +
    'document.addEventListener("change", function(e){' +
    '  if (e.target.classList.contains("allbox")) {' +
    '    var key = e.target.dataset.key;' +
    '    var checked = e.target.checked;' +
    '    document.querySelectorAll(".itembox[data-key=\'" + key + "\']").forEach(function(cb){ cb.checked = checked; });' +
    '  } else if (e.target.classList.contains("itembox")) {' +
    '    var key = e.target.dataset.key;' +
    '    var all = document.querySelectorAll(".itembox[data-key=\'" + key + "\']");' +
    '    var allChecked = Array.prototype.every.call(all, function(cb){ return cb.checked; });' +
    '    document.querySelector(".allbox[data-key=\'" + key + "\']").checked = allChecked;' +
    '  }' +
    '});' +
    'function readKey(key){' +
    '  var boxes = document.querySelectorAll(".itembox[data-key=\'" + key + "\']");' +
    '  var vals = [];' +
    '  boxes.forEach(function(cb){ if (cb.checked) vals.push(cb.value); });' +
    '  return vals;' +
    '}' +
    'function aplicar(){' +
    '  var seleccion = { cliente: readKey("cliente"), objeto: readKey("objeto"), trabajador: readKey("trabajador") };' +
    '  google.script.run.withSuccessHandler(function(){ google.script.host.close(); }).guardarFiltrosSeleccionados(seleccion);' +
    '}' +
    '</script>';

  var html = HtmlService.createHtmlOutput(htmlBody).setWidth(380).setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'Elegir filtros (Cliente / Objeto / Trabajador)');
}

// Llamado desde el diálogo (google.script.run) — guarda la selección y,
// como escribir en las celdas de filtro YA dispara onEdit()
// (_onEditEstadisticas), la tabla "Informes del período" se refresca sola
// justo después, sin tener que llamarla desde aquí también.
function guardarFiltrosSeleccionados(seleccion) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  function listFrom(col) {
    var values = sheet.getRange(col + '2:' + col + '500').getValues();
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var v = String(values[i][0]).trim();
      if (v && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }
  function writeSel(namedRangeName, arr, allList) {
    var r = ss.getRangeByName(namedRangeName);
    if (!r) return;
    if (!arr || arr.length === 0 || arr.length >= allList.length) {
      r.setValue('(Todos)');
    } else {
      r.setValue(arr.join(', '));
    }
  }
  writeSel('EST_CLIENTE', seleccion.cliente, listFrom('T'));
  writeSel('EST_OBRA', seleccion.objeto, listFrom('U'));
  writeSel('EST_OPERARIO', seleccion.trabajador, listFrom('V'));
}

/* ── Página de estadísticas EN LA PROPIA HOJA (fórmulas vivas) ──
 * Pedido original: una pestaña de la spreadsheet con fórmulas nativas de
 * Sheets (SUM/QUERY) que se recalculan solas cada vez que cambia
 * INFORME — ningún script tiene que volver a ejecutarse después de
 * crearla. Pedido posterior (esta reescritura): un panel de filtros
 * (fecha/cliente/objeto/trabajador) con una tabla que se actualiza sola
 * al elegirlos, un bloque fijo del mes en curso por objeto, y poder
 * generar el informe PDF/Excel directamente desde el menú AEDIS — sin
 * perder las 3 secciones "todos los tiempos" ya existentes, que se dejan
 * tal cual más abajo.
 * Ejecuta esto UNA vez desde el editor de Apps Script (o desde el menú
 * AEDIS ▸ "Regenerar hoja de estadísticas") y de nuevo cuando quieras
 * reconstruirla desde cero — borra y recrea la hoja cada vez, así que no
 * uses esta hoja para guardar nada a mano.
 * TRABAJO se deriva siempre como TOTAL−MATERIALES (columnas Q y P/Q según
 * la sección) en vez de repetir la fórmula HORAS×PRECIO_HORA con su
 * fallback al PRICE_PER_HOUR global — así la única fuente de verdad de
 * esa cuenta sigue siendo la columna TOTAL, que la app y el trigger
 * onEdit() ya mantienen actualizada; una copia de esa lógica aquí sería
 * un segundo sitio que se puede desincronizar del primero.
 * Columnas de INFORME usadas (INFORME_COL): FECHA=C, CLIENTE=D, OBRA=E,
 * OPERARIO=F, HORAS=L, PRECIO(materiales)=Q, TOTAL=R. Si PRECIO_HORA se
 * vuelve a mover de columna en el futuro, estas letras hay que
 * recalcularlas a mano (QUERY/SUM/SUMIFS no referencian por nombre). */

// Nombre de la hoja OCULTA donde se guarda el snapshot de formato — vive
// como una hoja normal (no en Script Properties, que tiene un límite de
// ~9 KB por propiedad, demasiado poco para el fondo/fuente/ancho de cada
// celda de una hoja de este tamaño) para que viaje con el propio archivo.
var EST_DISENO_SHEET = '_EST_DISEÑO_GUARDADO';

/* Pedido explícito 2026-07-27: un botón que guarde el aspecto ACTUAL
 * (colores de fondo, estilo/tamaño de texto, alineación, anchos de
 * columna, altos de fila) para que sobreviva incluso a "⚠️ Reconstruir
 * hoja desde cero" — que por diseño borra y vuelve a crear la hoja entera.
 * Guarda un snapshot en una hoja oculta aparte (JSON en A1); createEstadisticasSheet()
 * lo reaplica automáticamente al final si existe. Solo guarda ASPECTO,
 * nunca fórmulas/valores — los datos siempre los reconstruye el código,
 * nunca el snapshot. */
function guardarDisenoActual() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EST_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No existe la hoja ' + EST_SHEET_NAME + '.');
    return;
  }
  var range = sheet.getDataRange();
  var numRows = range.getNumRows(), numCols = range.getNumColumns();
  var snapshot = {
    numRows: numRows,
    numCols: numCols,
    backgrounds: range.getBackgrounds(),
    fontColors: range.getFontColors(),
    fontFamilies: range.getFontFamilies(),
    fontSizes: range.getFontSizes(),
    fontWeights: range.getFontWeights(),
    fontStyles: range.getFontStyles(),
    horizontalAlignments: range.getHorizontalAlignments(),
    columnWidths: [],
    rowHeights: []
  };
  for (var c = 1; c <= numCols; c++) snapshot.columnWidths.push(sheet.getColumnWidth(c));
  for (var r = 1; r <= numRows; r++) snapshot.rowHeights.push(sheet.getRowHeight(r));

  var disenoSheet = ss.getSheetByName(EST_DISENO_SHEET);
  if (!disenoSheet) {
    disenoSheet = ss.insertSheet(EST_DISENO_SHEET);
    disenoSheet.hideSheet();
  }
  disenoSheet.getRange(1, 1).setValue(JSON.stringify(snapshot));
  ss.toast('Aspecto actual guardado — sobrevivirá a "Reconstruir hoja desde cero".', 'AEDIS', 6);
}

/* Reaplica el snapshot guardado por guardarDisenoActual(), si existe.
 * Se limita a min(filas/columnas guardadas, filas/columnas actuales) —
 * si la hoja reconstruida es más pequeña que cuando se guardó el
 * snapshot (o al revés), no intenta escribir fuera de rango en ningún
 * sentido. No toca fórmulas ni valores, solo aspecto. */
function _estRestaurarDisenoGuardado(sheet) {
  var ss = sheet.getParent();
  var disenoSheet = ss.getSheetByName(EST_DISENO_SHEET);
  if (!disenoSheet) return;
  var raw = disenoSheet.getRange(1, 1).getValue();
  if (!raw) return;
  var snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (err) {
    return; // snapshot corrupto — no interrumpe la reconstrucción por esto
  }

  var numRows = Math.min(snapshot.numRows, sheet.getMaxRows());
  var numCols = Math.min(snapshot.numCols, sheet.getMaxColumns());
  if (numRows < 1 || numCols < 1) return;

  function trim2D(arr) {
    return arr.slice(0, numRows).map(function (row) { return row.slice(0, numCols); });
  }

  var target = sheet.getRange(1, 1, numRows, numCols);
  target.setBackgrounds(trim2D(snapshot.backgrounds));
  target.setFontColors(trim2D(snapshot.fontColors));
  target.setFontFamilies(trim2D(snapshot.fontFamilies));
  target.setFontSizes(trim2D(snapshot.fontSizes));
  target.setFontWeights(trim2D(snapshot.fontWeights));
  target.setFontStyles(trim2D(snapshot.fontStyles));
  target.setHorizontalAlignments(trim2D(snapshot.horizontalAlignments));

  for (var c = 0; c < Math.min(snapshot.columnWidths.length, numCols); c++) {
    sheet.setColumnWidth(c + 1, snapshot.columnWidths[c]);
  }
  for (var r = 0; r < Math.min(snapshot.rowHeights.length, numRows); r++) {
    sheet.setRowHeight(r + 1, snapshot.rowHeights[r]);
  }
}

function createEstadisticasSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var old = ss.getSheetByName(EST_SHEET_NAME);
  if (old) ss.deleteSheet(old);
  var sheet = ss.insertSheet(EST_SHEET_NAME);
  sheet.setTabColor('#4a86e8');

  // Las fórmulas se escriben con setFormula() en sintaxis US (comas como
  // separador de argumentos). Si la spreadsheet tiene el idioma regional
  // en un locale que usa ";" (p.ej. Ruso, Español de España...), eso
  // puede acabar en "#ERROR!" en TODAS las fórmulas de esta hoja, hasta
  // las más simples — visto en producción. Se cambia el locale a en_US
  // solo mientras se escriben las fórmulas y se restaura siempre al
  // original (try/finally) — Sheets recalcula el texto guardado según el
  // locale ACTUAL, así que esto no dañina nada fuera de esta función.
  var localeOriginal = ss.getSpreadsheetLocale();
  try {
    ss.setSpreadsheetLocale('en_US');
    _buildEstadisticasSheetContent(sheet, ss);
  } finally {
    ss.setSpreadsheetLocale(localeOriginal);
  }

  // Pedido explícito 2026-07-27: si hay un aspecto guardado (ver
  // guardarDisenoActual()), reaplicarlo AHORA — después de que el
  // contenido/las fórmulas ya estén en su sitio, para que "Reconstruir
  // hoja desde cero" deje de borrar el estilo elegido a mano.
  _estRestaurarDisenoGuardado(sheet);

  Logger.log('✅ Hoja ESTADÍSTICAS creada: filtros + recargos + resultados en vivo + mes actual por objeto + menú AEDIS + secciones "todos los tiempos" (ahora más abajo).');
}

function _buildEstadisticasSheetContent(sheet, ss) {
  // Direcciones A1 "físicas" usadas SOLO al construir la hoja por
  // primera vez — el resto del código (fórmulas, createReportFromSheetFilters,
  // refreshEstadisticasFormulas) nunca las usa directamente, solo los
  // nombres en EST_CELLS. Tras colocar cada celda aquí se registra su
  // rango con nombre correspondiente.
  // Fila 12 (antes "Tarifa €/h") se borra al final de esta función — ver
  // sheet.deleteRow(12) más abajo — así que FORMATO/RESULTADO ya no
  // necesitan renumerarse aquí: se escriben en A13/B13, A14/B14 como
  // siempre, y quedan en A12/B12, A13/B13 tras el borrado.
  var CELL_A1 = {
    DESDE: 'A5', HASTA: 'B5', CLIENTE: 'B7', OBRA: 'B8', OPERARIO: 'B9',
    PCT_MATERIALES: 'B10', PCT_TRABAJO: 'B11',
    FORMATO: 'B13', RESULTADO: 'B14'
  };
  // ── Título ──
  sheet.getRange(1, 1, 1, 9).merge().setValue('PANEL AEDIS — ESTADÍSTICAS')
    .setFontWeight('bold').setFontSize(16).setFontColor('#0b3d91');
  sheet.setRowHeight(1, 34);

  // ── Columnas ocultas de origen para los desplegables (T/U/V), siempre
  // al día solas: cada una es "(Todos)" + la lista viva. Cliente/Objeto
  // se cruzan con DOS fuentes a la vez — servicio!A/B (la lista maestra,
  // incluye clientes/objetos recién creados aún sin ningún informe
  // aprobado) UNIDA con INFORME!D/E (lo que de verdad tiene informes
  // aprobados) — pedido explícito: que un cliente/objeto nuevo aparezca
  // en el desplegable aunque, por lo que sea, no haya quedado sincronizado
  // en servicio (appendServicioClienteObra normalmente lo hace solo, pero
  // esto no depende de esa sincronización para funcionar). Mismo truco de
  // apilar dos rangos con {rango1;rango2} ya usado para Trabajador. ──
  sheet.getRange('T1').setValue('(Todos)');
  sheet.getRange('T2').setFormula('=SORT(UNIQUE(FILTER({servicio!A2:A;INFORME!D2:D},{servicio!A2:A;INFORME!D2:D}<>"")))');
  sheet.getRange('U1').setValue('(Todos)');
  sheet.getRange('U2').setFormula('=SORT(UNIQUE(FILTER({servicio!B2:B;INFORME!E2:E},{servicio!B2:B;INFORME!E2:E}<>"")))');
  sheet.getRange('V1').setValue('(Todos)');
  sheet.getRange('V2').setFormula('=SORT(UNIQUE(FILTER({servicio!C2:C;servicio!D2:D},{servicio!C2:C;servicio!D2:D}<>"")))');

  // ── Filtros (izquierda, A:B) + 4 indicadores en vivo, en cuadrícula
  // 2×2 (D:E), calcado del estilo azul que el usuario armó a mano:
  // cabecera azul marino + valor en celda combinada de 2 filas, en tono
  // celeste uniforme (no un color distinto por tile). Pedido: "celdas de
  // informe: qué participantes crearon informes / cuántos informes
  // cuentan en el período / cuánto dinero en materiales / cuánto dinero
  // en pago al trabajo" — mismo concepto que los 4 tiles de "Resumen del
  // período" de la app (getAnalyticsSummary), aquí en vivo con
  // SUMIFS/COUNTIFS, respetando cliente/objeto/trabajador con el truco
  // de comodín "<>" (ver EST_WILDCARD_CRIT). ──
  _estSectionHeader(sheet, 3, 'FILTROS', 2);
  var TILE_HEADER_BG = '#0b3d91', TILE_VALUE_BG = '#dbe9ff';
  // Placeholder 0 en vez de fórmula — el valor real lo escribe
  // _estComputeTiles(sheet) (JS, no fórmula) justo después de crear las 4
  // plaquitas; ver su comentario para el porqué del cambio de diseño.
  function _estTile(headerRow, col, label, isMoney, namedRangeName) {
    sheet.getRange(headerRow, col).setValue(label).setFontWeight('bold').setFontColor('#ffffff')
      .setBackground(TILE_HEADER_BG).setHorizontalAlignment('center');
    var val = sheet.getRange(headerRow + 1, col, 2, 1);
    val.merge().setValue(0).setFontWeight('bold').setFontSize(18).setFontColor('#0b3d91')
      .setBackground(TILE_VALUE_BG).setHorizontalAlignment('center').setVerticalAlignment('middle');
    if (isMoney) val.setNumberFormat('#,##0.00 €');
    // Rango con nombre sobre la celda ANCLA del merge (headerRow+1, col) —
    // así refreshEstadisticasFormulas() encuentra la plaquita aunque el
    // usuario la haya movido o redimensionado.
    _estSetNamedRange(ss, namedRangeName, sheet.getRange(headerRow + 1, col));
  }
  _estTile(3, 4, 'TRABAJADORES', false, 'EST_TILE_TRAB');
  _estTile(3, 5, 'INFORMES', false, 'EST_TILE_INF');
  _estTile(6, 4, 'MATERIALES', true, 'EST_TILE_MAT');
  _estTile(6, 5, 'REMUNERACIÓN', true, 'EST_TILE_REM');
  // NOTA: _estComputeTiles(sheet) se llama más abajo, DESPUÉS de que
  // EST_DESDE/EST_HASTA/etc. estén registrados (ver el bloque
  // Object.keys(CELL_A1).forEach) — llamarlo aquí mismo, justo después de
  // crear las 4 plaquitas, es un BUG REAL encontrado el 2026-07-27
  // (cuarta continuación) probando "⚠️ Reconstruir hoja desde cero" contra
  // un mock de Apps Script: _estComputeTiles lee
  // ss.getRangeByName('EST_DESDE').getValue() sin comprobar null, y en
  // este punto de la función ese rango con nombre TODAVÍA NO EXISTE —
  // lanza "Cannot read properties of null" y aborta toda la reconstrucción
  // a medias. Muy probablemente la razón real de que este proyecto nunca
  // haya tenido una "Reconstruir hoja desde cero" confirmada como exitosa
  // en ninguna sesión anterior.

  // Desde/Hasta como un mini bloque de 2 columnas (cabecera en la fila 4,
  // valor en la fila 5) en vez de 2 filas separadas — calcado del
  // recuadro gris "Desde | Hasta" lado a lado de la referencia.
  sheet.getRange('A4').setValue('Desde').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange('B4').setValue('Hasta').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(4, 1, 2, 2).setBackground('#ececec'); // "tarjeta" gris del rango de fechas
  sheet.getRange('A6').setValue('Seleccione el rango del informe.').setFontStyle('italic').setFontColor('#666666');
  var etiquetasDesdeFila7 = ['Cliente', 'Objeto', 'Trabajador'];
  for (var fi = 0; fi < etiquetasDesdeFila7.length; fi++) {
    sheet.getRange(7 + fi, 1).setValue(etiquetasDesdeFila7[fi]).setFontWeight('bold').setHorizontalAlignment('right');
  }
  // Recargos: la etiqueta va sola en A, el símbolo "%" como pista suelta
  // en C (no forma parte del texto de la etiqueta ni del valor). El campo
  // "Tarifa €/h" que vivía aquí (fila 12) se retiró el 2026-07-27
  // (continuación) — no hacía nada real; la fila se borra al final de
  // esta función (ver sheet.deleteRow(12)) para no dejar un hueco.
  sheet.getRange('A10').setValue('Recargo materiales').setFontWeight('bold');
  sheet.getRange('C10').setValue('%').setFontColor('#999999');
  sheet.getRange('A11').setValue('Recargo trabajo').setFontWeight('bold');
  sheet.getRange('C11').setValue('%').setFontColor('#999999');

  // Fórmulas, no valores fijos — así el rango por defecto sigue solo al
  // mes en curso (1 de agosto → todo agosto; el 1 de septiembre pasa a
  // mostrar todo septiembre, sin tener que regenerar la hoja). Si el
  // usuario escribe/elige una fecha concreta encima, sustituye la
  // fórmula sin problema, como cualquier celda de Sheets. Formato
  // dd.mm.yyyy (pedido explícito) + validación "es una fecha" — esta
  // última es lo que hace que Sheets muestre el icono de calendario al
  // hacer clic en la celda, no el formato de número por sí solo.
  var dateValidation = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build();
  sheet.getRange(CELL_A1.DESDE).setFormula('=DATE(YEAR(TODAY()),MONTH(TODAY()),1)')
    .setNumberFormat('dd.mm.yyyy').setHorizontalAlignment('center').setDataValidation(dateValidation);
  // Hasta = HOY, no fin de mes — pedido explícito 2026-07-27: el rango
  // por defecto debe incluir los informes presentados hoy mismo, no
  // extenderse a días futuros del mes que aún no tienen datos.
  sheet.getRange(CELL_A1.HASTA).setFormula('=TODAY()')
    .setNumberFormat('dd.mm.yyyy').setHorizontalAlignment('center').setDataValidation(dateValidation);
  sheet.getRange(CELL_A1.CLIENTE).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(sheet.getRange('T1:T500'), true).setAllowInvalid(false).build()
  ).setValue('(Todos)').setBackground('#0b3d91').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange(CELL_A1.OBRA).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(sheet.getRange('U1:U500'), true).setAllowInvalid(false).build()
  ).setValue('(Todos)').setBackground('#0b3d91').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange(CELL_A1.OPERARIO).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(sheet.getRange('V1:V500'), true).setAllowInvalid(false).build()
  ).setValue('(Todos)').setBackground('#0b3d91').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange(CELL_A1.PCT_MATERIALES).setValue(0).setNumberFormat('0.##')
    .setFontWeight('bold').setFontColor('#0b3d91').setFontSize(13);
  sheet.getRange(CELL_A1.PCT_TRABAJO).setValue(0).setNumberFormat('0.##')
    .setFontWeight('bold').setFontColor('#0b3d91').setFontSize(13);
  sheet.getRange(4, 1, 9, 2).setBorder(true, true, true, true, true, true, '#c7d7f0', SpreadsheetApp.BorderStyle.SOLID);

  // Rangos con nombre — pedido explícito: que reordenar/redimensionar
  // estas celdas no rompa las fórmulas que las usan (ver EST_CELLS).
  Object.keys(CELL_A1).forEach(function (key) {
    _estSetNamedRange(ss, EST_CELLS[key], sheet.getRange(CELL_A1[key]));
  });

  // Ahora sí — EST_DESDE/EST_HASTA/EST_CLIENTE/EST_OBRA/EST_OPERARIO ya
  // existen, así que _estComputeTiles puede leerlos sin lanzar excepción.
  _estComputeTiles(sheet);

  // ── Formato + resultado, de vuelta en la columna A:B (pedido explícito
  // — antes vivían en H:I, lejos de los demás filtros). Se quitó el
  // cartel "▶ CREAR UN INFORME" (pedido explícito, "no funciona") — es
  // cierto que nunca fue un botón real, solo una celda con color; Apps
  // Script no tiene forma de crear un botón clicable por código (solo se
  // puede insertar un Dibujo a mano desde el menú Insertar, y ese Dibujo
  // se perdería en cada "Regenerar hoja de estadísticas" al borrar y
  // recrear la hoja entera). El único disparador real sigue siendo el
  // menú AEDIS ▸ "Crear informe desde filtros" — se deja solo como texto
  // simple, sin fingir ser un botón. ──
  sheet.getRange('A13').setValue('Formato del informe').setFontWeight('bold');
  sheet.getRange(CELL_A1.FORMATO).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['pdf', 'xlsx'], true).setAllowInvalid(false).build()
  ).setValue('pdf');
  sheet.getRange('A14').setValue('Último informe generado').setFontWeight('bold');
  sheet.getRange(CELL_A1.RESULTADO).setValue('(todavía no generado)').setFontColor('#666666');
  sheet.getRange(15, 1, 1, 5).merge()
    .setValue('Genera el archivo desde el menú AEDIS ▸ "Crear informe desde filtros". Los indicadores y la tabla se recalculan solos al cambiar los filtros.')
    .setFontStyle('italic').setFontColor('#666666');

  // ── Resultados según filtro — una fila por OBJETO (Cliente+Obra) en el
  // período/filtros elegidos. El filtro de Trabajador sigue acotando qué
  // filas cuentan, solo que ya no es una columna de desglose (pedido de
  // una ronda anterior). Materiales/Trabajo/Total muestran los valores
  // YA CON el % de recargo y la tarifa manual aplicados (pedido de una
  // ronda anterior) — ver _estApplyFiltroFormulas() para el porqué del
  // diseño (columnas ocultas + ARRAYFORMULA, tras un primer intento con
  // aritmética embebida en QUERY que se rompió en vivo).
  //
  // Pedido de una ronda anterior, sigue vigente: que la fila TOTAL esté
  // SIEMPRE justo debajo de la última fila real, sin depender de un nº
  // de filas reservado fijo. Con una fórmula QUERY normal eso es
  // imposible — la posición de una celda no puede "seguir" el tamaño de
  // otra fórmula. Solución: apilar la fila TOTAL DENTRO de la misma
  // fórmula que QUERY, con un literal de array `={QUERY(...);{"TOTAL",
  // ...}}` — el TOTAL pasa a ser literalmente la última fila del mismo
  // resultado, sea cual sea su tamaño (0, 1 o 50 objetos). Ya no hay
  // ninguna sección fija debajo de esta tabla en la hoja (las 3
  // secciones "todos los tiempos" se quitaron esta misma ronda), así que
  // tampoco hay ya un límite práctico de filas que cuidar.
  _estSectionHeader(sheet, 19, 'RESULTADOS SEGÚN FILTRO', 5);
  _estApplyFiltroFormulas(sheet, 20, 1);
  _estSetNamedRange(ss, 'EST_FILTRO_TABLE', sheet.getRange(20, 1));

  var totalRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$A20="TOTAL"')
    .setBold(true).setFontColor('#0b3d91')
    .setRanges([sheet.getRange(20, 1, 200, 5)])
    .build();
  sheet.setConditionalFormatRules([totalRule]);

  // ── INFORMES DEL PERIODO (F en adelante, misma fila que "RESULTADOS
  // SEGÚN FILTRO") — una fila por INFORME dentro de los 5 filtros
  // (fecha+cliente+obra+operario), añadida el 2026-07-27 junto al
  // maquetado que el usuario ya había hecho a mano en la hoja real;
  // aquí se replica para que una futura "Reconstruir hoja desde cero" no
  // la pierda. NOTA: esta tabla vive en F:O, que solapa en columnas
  // (aunque no en fila, hoy) con RESUMEN GENERAL (G:K, filas 3-50 más
  // abajo) — el margen de 40 filas que ese bloque ya se reservaba para
  // crecer (ver su propio comentario) ya no tiene el terreno totalmente
  // libre que asumía; si el nº de objetos del año llega a acercarse a
  // fila 19, ambas secciones chocarían. ──
  _estSectionHeader(sheet, 19, 'INFORMES DEL PERIODO', EST_INFORMES_HEADERS.length, false, 6);
  _estApplyInformesPeriodoFormula(sheet, 20, 6, true); // reconstrucción desde cero — sí aplica el estilo uniforme

  // ── RESUMEN GENERAL (año en curso) — pedido: se mueve junto a los
  // filtros/indicadores (columna G, siempre visible sin bajar a
  // desplazarse) en vez de vivir al final de la hoja. Formato "limpio"
  // (pedido explícito): primero la lista por objeto (Cliente+Obra), y
  // debajo los indicadores (Informes aprobados/Trabajadores distintos/
  // Materiales/Trabajo/TOTAL) — mismo orden que la referencia enviada.
  // El título lleva el año como FÓRMULA, igual que Desde/Hasta, para que
  // el 1 de enero pase solo a decir "(2027)" sin regenerar la hoja.
  // Se deja un margen de 40 filas (G4→G44) antes del bloque de
  // indicadores — pensado para que entren nuevos clientes/objetos según
  // se vayan dando de alta en servicio/INFORME sin chocar; no hay nada
  // más debajo en esta columna con lo que pueda chocar si la tabla crece
  // más de eso, pero si el nº de objetos del año se acerca a esa cifra,
  // este margen habría que ampliarlo otra vez. ──
  var yearCrit = 'INFORME!C2:C,">="&DATE(YEAR(TODAY()),1,1),INFORME!C2:C,"<="&DATE(YEAR(TODAY()),12,31)';
  _estSectionHeader(sheet, 3, '="RESUMEN GENERAL ("&YEAR(TODAY())&")"', 5, true, 7);
  _estSetNamedRange(ss, 'EST_YEAR_TITLE', sheet.getRange(3, 7));
  // Calculado en Apps Script, no fórmula QUERY — ver _estApplyYearTableFormula.
  // Registra EST_YEAR_TABLE ella misma.
  _estApplyYearTableFormula(sheet, 4, 7);

  // Recortado a 2 filas en I12:J13 el 2026-07-27, pedido explícito: solo
  // "Informes aprobados"/"Trabajadores distintos" — Materiales/Trabajo/
  // Total (año) se quitaron por duplicar la fila TOTAL que ya muestra
  // EST_YEAR_TABLE justo encima (misma sección, mismo alcance de año).
  var yearLabels = ['Informes aprobados', 'Trabajadores distintos'];
  var yearFormulas = [
    '=COUNTIFS(' + yearCrit + ')',
    '=IFERROR(COUNTA(UNIQUE(FILTER(INFORME!F2:F,YEAR(INFORME!C2:C)=YEAR(TODAY()),INFORME!F2:F<>""))),0)'
  ];
  for (var yi = 0; yi < yearLabels.length; yi++) {
    sheet.getRange(12 + yi, 9).setValue(yearLabels[yi]).setHorizontalAlignment('right');
    sheet.getRange(12 + yi, 10).setFormula(yearFormulas[yi]).setFontWeight('bold').setHorizontalAlignment('right');
  }
  _estSetNamedRange(ss, 'EST_YEAR_KPI_TOP', sheet.getRange(12, 9));

  sheet.hideColumns(28, 5); // AB:AF — valores brutos ocultos de "Resultados según filtro" (ver _estApplyFiltroFormulas; movida de M:Q el 2026-07-27 porque esa zona ahora es la tabla visible "Informes del período")
  sheet.hideColumns(20, 3); // T:V — solo listas fuente de los desplegables

  // La fila 12 (antes "Tarifa €/h", ver más arriba) queda vacía tras
  // retirar ese campo — se borra aquí al final, en vez de dejar un hueco,
  // para que Formato/Resultado (A13/B13, A14/B14) queden justo debajo de
  // los recargos, sin fila en blanco entre medio. Todo lo escrito más
  // abajo en esta misma función (nota, "Resultados según filtro", RESUMEN
  // GENERAL en columna G, "Informes del período", listas T:V, etc.) se
  // desplaza una fila hacia arriba junto con esta — y los rangos con
  // nombre ya registrados más arriba (FORMATO/RESULTADO/EST_YEAR_*/EST_TILE_*)
  // se actualizan solos: Sheets sigue automáticamente a un rango con
  // nombre cuando se borra una fila por encima, mismo comportamiento del
  // que ya depende todo este archivo para sobrevivir a reordenaciones.
  sheet.deleteRow(12);

  sheet.setFrozenRows(14);  // eran 15 — una fila menos tras borrar la 12 (antes Tarifa)
  sheet.autoResizeColumns(1, 11);
}

function nextInformeGeneradoId() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_COUNTER);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_COUNTER);
  var last = parseInt(sheet.getRange(2, 3).getValue()) || 0;
  var next = last + 1;
  sheet.getRange(2, 3).setValue(next);
  return 'RPT-' + ('0000' + next).slice(-4);
}

/* Simple trigger — Apps Script lo reconoce por el nombre exacto "onEdit"
 * y lo ejecuta automáticamente en cada edición de CUALQUIER hoja de esta
 * spreadsheet, sin que el usuario tenga que instalar nada desde el menú
 * Triggers (a diferencia de un installable trigger). Los simple triggers
 * pueden leer/escribir cualquier hoja de la MISMA spreadsheet sin
 * autorización extra (a diferencia de UrlFetchApp/MailApp, que sí la
 * necesitan) — de sobra para esta sincronización.
 * Pedido: el admin edita la tarifa/hora directamente en la celda de
 * INFORME (columna PRECIO_HORA) — aquí se recalcula TOTAL en esa misma
 * fila y se refleja también en la fila equivalente de PARTE DE TRABAJO
 * (mismo ID), para que la app (que lee TOTAL de PARTE en getAdminStats/
 * getHistorial) muestre la cifra ya actualizada sin esperar a un nuevo
 * approve. Deliberadamente NO reacciona a ediciones de HORAS — solo se
 * pidió poder cambiar la tarifa, no las horas trabajadas, para no abrir
 * la puerta a reescribir el registro original del operario. Soporta
 * pegar en varias filas/celdas a la vez (e.range puede cubrir más de
 * una), no solo una edición celda a celda. */
function onEdit(e) {
  try {
    var sheet = e.range.getSheet();
    if (sheet.getName() === SHEET_INFORME) {
      _onEditInforme(e, sheet); // recalcula TOTAL — no notifica, ver el comentario dentro de _onEditInforme
    } else if (sheet.getName() === EST_SHEET_NAME) {
      _onEditEstadisticas(e, sheet);
    }
  } catch (err) {
    Logger.log('onEdit error: ' + err.message);
  }
}

/* Trigger INSTALABLE equivalente al onEdit(e) simple de arriba, con
 * autorización completa del script (a diferencia del simple), así que
 * aquí SÍ puede notificar a los admins vía notifyAdminsTarifaCambiada
 * (que llama a UrlFetchApp). No sustituye al onEdit(e) simple — ambos
 * siguen ejecutándose en cada edición (_onEditInforme/_onEditEstadisticas
 * son idempotentes, recalcular TOTAL dos veces no hace daño), pero SOLO
 * este puede terminar de avisar. Requiere haber ejecutado
 * instalarTriggerNotificacionTarifa() una vez — si no, esta función
 * nunca se dispara y las notificaciones de "tarifa cambiada a mano"
 * simplemente no salen (el recálculo de TOTAL en sí no depende de esto,
 * eso ya funciona siempre vía el trigger simple).
 *
 * 2026-07-28 (real, encontrado tras un reporte del usuario): al
 * principio esto solo cubría la hoja INFORME — editar la tarifa desde
 * la tabla "Informes del período" en ESTADÍSTICAS (que también la
 * escribe en INFORME, ver _onEditEstadisticas) recalculaba TOTAL bien
 * pero JAMÁS notificaba, porque este trigger la ignoraba por completo.
 * Ahora cubre ambas hojas — el nombre de la función no cambia a
 * propósito (aunque ya no sea 100% preciso) para no invalidar el
 * trigger que el usuario ya instaló con este nombre exacto. */
function onInformeEditarConAutorizacion(e) {
  try {
    var sheet = e.range.getSheet();
    var affected;
    if (sheet.getName() === SHEET_INFORME) {
      affected = _onEditInforme(e, sheet);
    } else if (sheet.getName() === EST_SHEET_NAME) {
      affected = _onEditEstadisticas(e, sheet);
    } else {
      return;
    }
    if (affected && affected.length) notifyAdminsTarifaCambiada(affected, null);
  } catch (err) {
    Logger.log('onInformeEditarConAutorizacion error: ' + err.message);
  }
}

/* Ejecutar UNA VEZ a mano (▶ Run en el editor de Apps Script, o desde el
 * nuevo ítem del menú AEDIS) para que las ediciones manuales de
 * PRECIO_HORA en INFORME también avisen a los admins — ver el comentario
 * de onInformeEditarConAutorizacion(). Segura de re-ejecutar: borra
 * cualquier trigger previo con el mismo handler antes de crear uno
 * nuevo, así que no se acumulan duplicados si se corre más de una vez. */
function instalarTriggerNotificacionTarifa() {
  var handlerName = 'onInformeEditarConAutorizacion';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(handlerName)
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  SpreadsheetApp.getUi().alert('Listo — a partir de ahora, cambiar la tarifa/hora a mano en INFORME también avisará a los admins por notificación push.');
}

function _onEditInforme(e, sheet) {
  var startCol = e.range.getColumn();
  var numCols = e.range.getNumColumns();
  var endCol = startCol + numCols - 1;
  var precioHoraCol = INFORME_COL.PRECIO_HORA + 1;
  var precioMatCol = INFORME_COL.PRECIO + 1;
  var editsPrecioHora = precioHoraCol >= startCol && precioHoraCol <= endCol;
  var editsPrecioMat = precioMatCol >= startCol && precioMatCol <= endCol;
  // BUG REAL encontrado el 2026-07-28 (reportado por el usuario: "si
  // cambio el precio en la tabla, no cambia en los informes"): esta
  // función solo reaccionaba a ediciones de PRECIO_HORA — cambiar a mano
  // el PRECIO (materiales) no disparaba nada, así que TOTAL se quedaba
  // con el valor antiguo tanto en INFORME como en PARTE DE TRABAJO,
  // aunque la celda de materiales sí hubiera cambiado. Ahora reacciona a
  // cualquiera de las dos columnas — TOTAL siempre se deriva de ambas.
  if (!editsPrecioHora && !editsPrecioMat) return;

  var startRow = e.range.getRow();
  var numRows = e.range.getNumRows();
  var sheetP = e.source.getSheetByName(SHEET_PARTE);
  var rowsP = sheetP ? sheetP.getDataRange().getValues() : [];
  // Lee hasta TOTAL (no solo hasta PRECIO_HORA) — PRECIO/TOTAL viven
  // DESPUÉS de PRECIO_HORA en INFORME, hace falta la fila entera hasta ahí.
  var readWidth = INFORME_COL.TOTAL + 1;

  // Pedido 2026-07-28: cambiar la tarifa a mano en la hoja (una celda o
  // pegando varias de golpe) debe avisar a los admins igual que el
  // reemplazo masivo desde la app/el menú — se acumulan aquí los
  // informes realmente tocados por ESTE evento de edición y se notifica
  // una sola vez al final, no por cada fila.
  var affected = [];

  for (var r = startRow; r < startRow + numRows; r++) {
    if (r === 1) continue; // cabecera
    var rowVals = sheet.getRange(r, 1, 1, readWidth).getValues()[0];
    var id = rowVals[INFORME_COL.ID];
    if (!id) continue;
    var horas = parseFloat(rowVals[INFORME_COL.HORAS]) || 0;
    var precioMateriales = parseFloat(rowVals[INFORME_COL.PRECIO]) || 0;
    var precioHora = parseFloat(rowVals[INFORME_COL.PRECIO_HORA]);
    if (isNaN(precioHora) || precioHora < 0) continue; // celda vacía o valor no numérico — no tocar nada

    var newTotal = horas * precioHora + precioMateriales;
    sheet.getRange(r, INFORME_COL.TOTAL + 1).setValue(newTotal);
    // Pedido 2026-07-28: notificar por CUALQUIER cambio de precio (tarifa
    // Y materiales), no solo la tarifa — se guardan como entradas
    // separadas para que el mensaje diga con precisión qué campo cambió.
    if (editsPrecioHora) affected.push({ id: id, campo: 'tarifa', valor: precioHora });
    if (editsPrecioMat) affected.push({ id: id, campo: 'materiales', valor: precioMateriales });

    if (!sheetP) continue;
    for (var i = 1; i < rowsP.length; i++) {
      if (String(rowsP[i][COL.ID]) === String(id)) {
        sheetP.getRange(i + 1, COL.TOTAL + 1).setValue(newTotal);
        break;
      }
    }
  }

  // IMPORTANTE: NO se notifica aquí. onEdit(e) es un trigger SIMPLE —
  // corre en modo restringido/sin autorización y NO puede llamar a
  // UrlFetchApp (lo necesita sendPushOneSignal para hablar con
  // OneSignal): el intento fallaría siempre, en silencio, y encima
  // desperdiciaría ~1.6s en reintentos en CADA edición manual de
  // PRECIO_HORA (ver sendPushOneSignal, 3 intentos con espera). Se
  // devuelve la lista de afectados para que la llame quien SÍ tenga
  // autorización completa — ver onInformeEditarConAutorizacion() más
  // abajo, el trigger INSTALABLE equivalente, y
  // instalarTriggerNotificacionTarifa() para darlo de alta una vez.
  return affected;
}

/* Nueva rama (2026-07-27): dos cosas distintas pasan en ESTADÍSTICAS y
 * ambas se gestionan aquí, en el mismo simple trigger:
 * (1) Cambiar una celda de filtro (Desde/Hasta/Cliente/Objeto/Trabajador)
 *     relanza el snapshot de "Informes del período" automáticamente — ya
 *     no es una fórmula en vivo (ver _estApplyInformesPeriodoFormula),
 *     así que sin esto habría que acordarse de pulsar un menú cada vez
 *     que se cambia un filtro.
 * (2) Editar HORAS o PRECIO HORA dentro de "Informes del período"
 *     escribe de vuelta en la fila correspondiente de INFORME (usando la
 *     columna ID oculta para encontrarla) y recalcula TOTAL ahí — mismo
 *     cálculo que ya hace la edición directa de PRECIO_HORA en INFORME.
 *     PARTE DE TRABAJO (el registro original del operario) solo recibe el
 *     TOTAL recalculado, NUNCA las HORAS editadas — a propósito, mismo
 *     principio que ya regía la edición directa en INFORME: no reescribir
 *     silenciosamente lo que el operario presentó originalmente. Editar
 *     HORAS aquí SÍ está permitido (a diferencia de la edición directa en
 *     INFORME, que deliberadamente solo dejaba tocar la tarifa) — pedido
 *     explícito del usuario para esta tabla en concreto. */
// El hack propio de multiselección (toggle por celda + celdas de estado
// ocultas AB1/AC1/AD1) se retiró el 2026-07-27 (continuación) — sustituido
// por la selección múltiple NATIVA de Sheets (desplegable "Chip" con
// "Permitir varias selecciones", ver el comentario junto a donde vivía
// _estConfigurarFiltrosMultiseleccionCore más arriba). onEdit ya no
// necesita interceptar el clic del desplegable: Sheets escribe el valor
// combinado "A, B" directamente, y el bloque genérico de más abajo
// (touchedFilter) ya recalcula todo en cuanto detecta el cambio.
function _onEditEstadisticas(e, sheet) {
  var ss = e.source;
  var editedCol = e.range.getColumn();
  var editedRow = e.range.getRow();
  var numRows = e.range.getNumRows();
  var numCols = e.range.getNumColumns();

  // PCT_MAT/PCT_TRAB incluidos aquí también: desde que "Resultados según
  // filtro" dejó de ser fórmula en vivo, cambiar el recargo necesita el
  // mismo disparador que cambiar una fecha o un Cliente/Objeto/Trabajador
  // — si no, esos 2 campos dejarían de recalcular nada por su cuenta.
  var filterNames = ['EST_DESDE', 'EST_HASTA', 'EST_CLIENTE', 'EST_OBRA', 'EST_OPERARIO', 'EST_PCT_MAT', 'EST_PCT_TRAB'];
  var touchedFilter = filterNames.some(function (name) {
    var r = ss.getRangeByName(name);
    if (!r) return false;
    return editedCol <= r.getColumn() && r.getColumn() <= editedCol + numCols - 1 &&
      editedRow <= r.getRow() && r.getRow() <= editedRow + numRows - 1;
  });
  if (touchedFilter) {
    // Las 4 plaquitas, "Resultados según filtro" e "Informes del período"
    // dejaron de ser fórmulas en vivo — ahora necesitan que algo las
    // recalcule explícitamente cada vez que cambia un filtro. Único punto
    // de refresco compartido, ver _estRefrescarTodoJS (también usado por
    // onOpen() y establecerRangoPorDefecto()).
    _estRefrescarTodoJS(sheet);
    return; // un cambio de filtro no es una edición de HORAS/PRECIO HORA, no seguir
  }

  var tableAnchor = ss.getRangeByName('EST_INFORMES_TABLE');
  if (!tableAnchor) return;
  var dataRow = tableAnchor.getRow() + 1;
  var startCol = tableAnchor.getColumn();
  var horasCol = startCol + EST_INFORMES_COL.HORAS;
  var precioHoraCol = startCol + EST_INFORMES_COL.PRECIO_HORA;
  var precioEurCol = startCol + EST_INFORMES_COL.PRECIO_EUR;

  if (editedRow < dataRow) return; // cabecera o por encima, no es un dato
  var editsHoras = horasCol >= editedCol && horasCol <= editedCol + numCols - 1;
  var editsPrecioHora = precioHoraCol >= editedCol && precioHoraCol <= editedCol + numCols - 1;
  // BUG REAL encontrado el 2026-07-28 (mismo síntoma reportado por el
  // usuario en INFORME: "si cambio el precio en la tabla, no cambia en
  // los informes"): esta tabla también deja editar la columna
  // MATERIALES (EUR) a mano, pero antes solo HORAS/PRECIO_HORA
  // disparaban el recálculo — cambiar el precio de materiales aquí no
  // hacía nada, ni siquiera se leía el valor nuevo de la celda.
  var editsPrecioMat = precioEurCol >= editedCol && precioEurCol <= editedCol + numCols - 1;
  if (!editsHoras && !editsPrecioHora && !editsPrecioMat) return;

  var idCol = startCol; // ID es ahora la primera columna VISIBLE de la tabla, no una oculta al final
  var informeSheet = ss.getSheetByName(SHEET_INFORME);
  if (!informeSheet) return;
  var infoData = informeSheet.getDataRange().getValues();
  var sheetP = ss.getSheetByName(SHEET_PARTE);
  var rowsP = sheetP ? sheetP.getDataRange().getValues() : [];

  // 2026-07-28: igual que en _onEditInforme, se acumulan los informes
  // cuya TARIFA (no materiales/horas) cambió de verdad en esta edición,
  // para que el trigger instalable (onInformeEditarConAutorizacion)
  // pueda notificar a los admins — ver ese comentario para el porqué de
  // por qué esta función NO notifica directamente (onEdit simple, sin
  // autorización para UrlFetchApp).
  var affected = [];

  for (var r = editedRow; r < editedRow + numRows; r++) {
    var id = sheet.getRange(r, idCol).getValue();
    if (!id) continue;
    var horasNew = parseFloat(sheet.getRange(r, horasCol).getValue());
    var precioHoraNew = parseFloat(sheet.getRange(r, precioHoraCol).getValue());
    var precioMatNew = parseFloat(sheet.getRange(r, precioEurCol).getValue());

    for (var i = 1; i < infoData.length; i++) {
      if (String(infoData[i][INFORME_COL.ID]) !== String(id)) continue;
      var infoRow = i + 1;
      var horasFinal = isNaN(horasNew) ? (parseFloat(infoData[i][INFORME_COL.HORAS]) || 0) : horasNew;
      var precioHoraFinal = isNaN(precioHoraNew) ? (parseFloat(infoData[i][INFORME_COL.PRECIO_HORA]) || 0) : precioHoraNew;
      var precioMateriales = isNaN(precioMatNew) ? (parseFloat(infoData[i][INFORME_COL.PRECIO]) || 0) : precioMatNew;
      var newTotal = horasFinal * precioHoraFinal + precioMateriales;

      if (!isNaN(horasNew)) informeSheet.getRange(infoRow, INFORME_COL.HORAS + 1).setValue(horasNew);
      if (!isNaN(precioHoraNew)) informeSheet.getRange(infoRow, INFORME_COL.PRECIO_HORA + 1).setValue(precioHoraNew);
      if (!isNaN(precioMatNew)) informeSheet.getRange(infoRow, INFORME_COL.PRECIO + 1).setValue(precioMatNew);
      informeSheet.getRange(infoRow, INFORME_COL.TOTAL + 1).setValue(newTotal);
      // Pedido 2026-07-28: notificar por cambio de tarifa Y de materiales,
      // no solo tarifa — mismo criterio que _onEditInforme.
      if (!isNaN(precioHoraNew)) affected.push({ id: id, campo: 'tarifa', valor: precioHoraFinal });
      if (!isNaN(precioMatNew)) affected.push({ id: id, campo: 'materiales', valor: precioMateriales });

      sheet.getRange(r, startCol + EST_INFORMES_COL.TOTAL).setValue(newTotal);

      if (sheetP) {
        for (var j = 1; j < rowsP.length; j++) {
          if (String(rowsP[j][COL.ID]) === String(id)) {
            sheetP.getRange(j + 1, COL.TOTAL + 1).setValue(newTotal); // solo TOTAL — nunca HORAS, ver comentario de arriba
            break;
          }
        }
      }
      break;
    }
  }

  return affected;
}

// Segundo contador independiente de nextId() (que usa A2 para PT-XXXX) —
// B2 de la misma hoja COUNTER, para no crear una hoja nueva solo por esto.
function nextUserId() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_COUNTER);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_COUNTER);
  var last = parseInt(sheet.getRange(2, 2).getValue()) || 0;
  var next = last + 1;
  sheet.getRange(2, 2).setValue(next);
  return 'U-' + ('0000' + next).slice(-4);
}

// Filas creadas a mano (antes de este cambio) no tienen STATUS — se tratan
// como 'active' si ACTIVO==='TRUE', igual que decidía checkUser() antes.
function statusOf(row) {
  var explicit = String(row[USR_COL.STATUS] || '').trim();
  if (explicit) return explicit;
  var activo = String(row[USR_COL.ACTIVO] || '').trim().toUpperCase();
  return activo === 'TRUE' ? 'active' : 'suspended';
}

function randomDigits(length) {
  var s = '';
  for (var i = 0; i < length; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// Código interno de sesión (columna A) para cuentas nuevas — NO es el PIN
// corto del keypad (ese lo asigna el admin aparte, ver adminSetUserCode /
// adminApproveUser). 10 dígitos: mismo "espacio" que el PIN pero
// suficientemente largo para que choque con un PIN corto existente sea,
// en la práctica, imposible.
function generateInternalCodigo() {
  return randomDigits(10);
}

function randomSalt() {
  return Utilities.getUuid();
}

// No hay bcrypt/scrypt en Apps Script — SHA-256 con sal es lo disponible
// nativamente (Utilities.computeDigest). Suficiente para el modelo de
// amenaza de esta app (equipo interno, pocas decenas de cuentas); si esto
// se convirtiera en algo internet-scale habría que migrar a un hash lento.
function hashPassword(password, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password) + '::' + String(salt));
  return bytes.map(function(b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function findUserRowByEmail(rows, email) {
  var target = String(email || '').trim().toLowerCase();
  if (!target) return -1;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][USR_COL.EMAIL] || '').trim().toLowerCase() === target) return i;
  }
  return -1;
}

function findUserRowByCodigo(rows, codigo) {
  var target = String(codigo || '').trim();
  if (!target) return -1;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][USR_COL.CODIGO] || '').trim() === target) return i;
  }
  return -1;
}

// Payload de sesión — misma forma que checkUser(), + codigo/accountStatus
// explícitos: checkUser() "de toda la vida" deliberadamente no devuelve
// codigo (ver el comentario histórico de saveUserCache en el frontend),
// pero las vías de login nuevas SÍ lo necesitan, porque currentPin es el
// identificador de sesión que usa el resto de la app en cada fetch().
function buildAuthPayload(row) {
  var obrasRaw = String(row[USR_COL.OBRAS] || '').trim();
  var pares = [];
  if (obrasRaw && obrasRaw !== '*') {
    obrasRaw.split(',').forEach(function(pair) {
      var parts = pair.split(':');
      if (parts.length === 2) pares.push({ cliente: parts[0].trim(), obra: parts[1].trim() });
    });
  }
  var langRaw = String(row[USR_COL.LANG] || '').trim().toLowerCase();
  return {
    status: 'ok', valid: true,
    codigo: String(row[USR_COL.CODIGO] || '').trim(),
    rol: String(row[USR_COL.ROL] || '').trim(),
    nombre: String(row[USR_COL.NOMBRE] || '').trim(),
    apellido: String(row[USR_COL.APELLIDO] || '').trim(),
    email: String(row[USR_COL.EMAIL] || '').trim(),
    allAccess: (obrasRaw === '*'),
    obras: pares,
    lang: (langRaw === 'ru' || langRaw === 'en') ? langRaw : 'es',
    accountStatus: statusOf(row)
  };
}

/* ── EMAIL: código de verificación + avisos de estado de cuenta ──
 * MailApp.sendEmail manda desde la cuenta de Google dueña de la hoja/script
 * — sin configuración adicional, límite ~100/día en cuenta gratuita, de
 * sobra para altas de personal. */
var OTP_EMAIL_SUBJECT = { es: 'Tu código de verificación — AEDIS', ru: 'Код подтверждения — AEDIS', en: 'Your verification code — AEDIS' };
function sendOtpEmail(email, nombre, code, lang) {
  var l = (lang === 'ru' || lang === 'en') ? lang : 'es';
  var subject = OTP_EMAIL_SUBJECT[l];
  var bodies = {
    es: 'Hola ' + nombre + ',\n\nTu código de verificación es: ' + code + '\nCaduca en ' + OTP_TTL_MINUTES + ' minutos.\n\nSi no has solicitado este registro, ignora este correo.',
    ru: 'Здравствуйте, ' + nombre + '!\n\nВаш код подтверждения: ' + code + '\nОн действителен ' + OTP_TTL_MINUTES + ' минут.\n\nЕсли вы не запрашивали регистрацию, проигнорируйте это письмо.',
    en: 'Hi ' + nombre + ',\n\nYour verification code is: ' + code + '\nIt expires in ' + OTP_TTL_MINUTES + ' minutes.\n\nIf you did not request this, please ignore this email.'
  };
  MailApp.sendEmail({ to: email, subject: subject, body: bodies[l] });
}

var STATUS_EMAIL_TEXTS = {
  es: { approved_subject: 'Tu cuenta AEDIS ha sido aprobada', approved_body: function(n){ return 'Hola ' + n + ',\n\nTu cuenta ha sido aprobada por un administrador. Ya puedes abrir la app e iniciar sesión.'; },
        rejected_subject: 'Tu solicitud de acceso a AEDIS', rejected_body: function(n){ return 'Hola ' + n + ',\n\nTu solicitud de acceso no ha sido aprobada. Si crees que es un error, contacta con tu administrador.'; } },
  ru: { approved_subject: 'Ваш аккаунт AEDIS одобрен', approved_body: function(n){ return 'Здравствуйте, ' + n + '!\n\nВаш аккаунт одобрен администратором. Теперь вы можете открыть приложение и войти.'; },
        rejected_subject: 'Заявка на доступ к AEDIS', rejected_body: function(n){ return 'Здравствуйте, ' + n + '!\n\nВаша заявка на доступ не была одобрена. Если это ошибка, свяжитесь с администратором.'; } },
  en: { approved_subject: 'Your AEDIS account was approved', approved_body: function(n){ return 'Hi ' + n + ',\n\nYour account has been approved by an admin. You can now open the app and log in.'; },
        rejected_subject: 'Your AEDIS access request', rejected_body: function(n){ return 'Hi ' + n + ',\n\nYour access request was not approved. If you think this is a mistake, contact your admin.'; } }
};
function sendUserStatusEmail(email, nombre, lang, approved) {
  var l = (lang === 'ru' || lang === 'en') ? lang : 'es';
  var txt = STATUS_EMAIL_TEXTS[l];
  MailApp.sendEmail({
    to: email,
    subject: approved ? txt.approved_subject : txt.rejected_subject,
    body: (approved ? txt.approved_body : txt.rejected_body)(nombre)
  });
}

function notifyAdminsNewSolicitud(nombreCompleto, rol) {
  try {
    var admins = getAdminPins();
    if (!admins.length) return;
    sendPushLocalized(admins, 'newuser_' + nombreCompleto + '_' + Date.now(), function(lang) {
      return {
        title: PUSH_TEXTS[lang].nueva_solicitud_title, // antes "AEDIS" genérico — duplicaba el "from AEDIS" de iOS
        body: PUSH_TEXTS[lang].nueva_solicitud(nombreCompleto, rol)
      };
    });
  } catch (e) { Logger.log('notifyAdminsNewSolicitud error: ' + e.message); }
}

/* Pedido 2026-07-28: avisar a los admins cuando cambia la tarifa/hora de
 * informes YA APROBADOS — nunca a operarios/managers, es un dato
 * económico interno. Cubre TODOS los sitios donde PRECIO_HORA o PRECIO
 * (materiales) pueden cambiar en INFORME: el reemplazo masivo desde la
 * app (replaceHourlyRate), el mismo reemplazo desde el menú de la hoja
 * (reemplazarTarifaPeriodo), la edición manual directa en INFORME
 * (_onEditInforme) y la edición vía la tabla "Informes del período" en
 * ESTADÍSTICAS (_onEditEstadisticas). affected: [{id, campo, valor}, ...]
 * — campo es 'tarifa' o 'materiales'. Se agrupan por (campo+valor) para
 * que "mismo cambio en varios informes" salga como una sola lista de
 * IDs en vez de una línea por informe (pedido explícito: "перечисление
 * отчетов где эта ставка/цена применилась"). actor: {nombre, rol} si se
 * conoce quién lo hizo (solo cuando viene de la app, que sí pasa por
 * checkUser) — si no se conoce (menú de la hoja o edición manual de una
 * celda, ninguno de los dos pasa por un PIN), el título es el genérico
 * "AEDIS" del sistema, igual que notifyAdminsNewSolicitud. */
function notifyAdminsTarifaCambiada(affected, actor) {
  try {
    if (!affected || !affected.length) return;
    var admins = getAdminPins();
    if (!admins.length) return;
    var byKey = {}, order = [];
    affected.forEach(function(a) {
      if (!a || !a.id) return;
      var campo = a.campo || 'tarifa'; // compat con cualquier llamador antiguo
      var key = campo + '|' + String(a.valor);
      if (!byKey[key]) { byKey[key] = { campo: campo, valor: a.valor, ids: [] }; order.push(key); }
      byKey[key].ids.push(String(a.id));
    });
    if (!order.length) return;
    var groups = order.map(function(k){ return byKey[k]; });
    var notifId = 'precio_' + Date.now();
    // Pedido 2026-07-28: "toco la notificación de cambio de tarifa y solo
    // abre la app, no el informe" — con un solo informe afectado en total
    // SÍ hay un destino inequívoco al que enlazar (a diferencia de cuando
    // el mismo cambio tocó varios informes a la vez, donde no hay "el"
    // informe al que abrir directamente).
    var allIds = [];
    groups.forEach(function(g){
      g.ids.forEach(function(id){ if (allIds.indexOf(id) === -1) allIds.push(id); });
    });
    var singleId = allIds.length === 1 ? allIds[0] : null;
    sendPushLocalized(admins, notifId, function(lang) {
      var texts = {
        title: (actor && actor.nombre) ? pushTitle(lang, actor.rol, actor.nombre) : PUSH_TEXTS[lang].precio_cambiado_title,
        body: PUSH_TEXTS[lang].precio_cambiado(groups)
      };
      if (singleId) texts.url = buildAppUrl(singleId, 'view');
      return texts;
    });
  } catch (e) { Logger.log('notifyAdminsTarifaCambiada error: ' + e.message); }
}

/* ── REGISTRO ── */
function registerUser(p) {
  var nombre = String(p.nombre || '').trim();
  var apellido = String(p.apellido || '').trim();
  var telefono = String(p.telefono || '').trim();
  var email = String(p.email || '').trim().toLowerCase();
  var password = String(p.password || '');
  var rol = String(p.rol || '').trim();
  var lang = String(p.lang || 'es').trim().toLowerCase();
  var viaGoogle = !!p.viaGoogle;
  var googleSub = String(p.googleSub || '').trim();

  if (!nombre || !apellido || !telefono || !email || !rol) throw new Error('Faltan datos');
  if (rol !== 'operario' && rol !== 'manager') throw new Error('Rol inválido');
  if (!viaGoogle && password.length < 6) throw new Error('Contraseña demasiado corta');
  if (email.indexOf('@') === -1) throw new Error('Email inválido');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var existingIdx = findUserRowByEmail(rows, email);
  if (existingIdx !== -1) {
    var existingStatus = statusOf(rows[existingIdx]);
    if (existingStatus !== 'rejected' && existingStatus !== 'deleted') throw new Error('Ese email ya está registrado');
  }

  var salt = randomSalt();
  var hash = viaGoogle ? '' : hashPassword(password, salt);
  var codigo = generateInternalCodigo();
  var userId = nextUserId();
  var status = viaGoogle ? 'pending_approval' : 'pending_verification';
  var otpCode = viaGoogle ? '' : randomDigits(6);
  var otpExpires = viaGoogle ? '' : String(Date.now() + OTP_TTL_MINUTES * 60000);

  var rowValues = [];
  rowValues[USR_COL.CODIGO] = codigo;
  rowValues[USR_COL.ROL] = rol;
  rowValues[USR_COL.NOMBRE] = nombre;
  rowValues[USR_COL.OBRAS] = '';
  rowValues[USR_COL.ACTIVO] = 'FALSE';
  rowValues[USR_COL.LANG] = lang;
  rowValues[USR_COL.APELLIDO] = apellido;
  rowValues[USR_COL.EMAIL] = email;
  rowValues[USR_COL.TELEFONO] = telefono;
  rowValues[USR_COL.PASSWORD_HASH] = hash;
  rowValues[USR_COL.PASSWORD_SALT] = salt;
  rowValues[USR_COL.GOOGLE_SUB] = googleSub;
  rowValues[USR_COL.STATUS] = status;
  rowValues[USR_COL.ID_USUARIO] = userId;
  rowValues[USR_COL.OTP_CODE] = otpCode;
  rowValues[USR_COL.OTP_EXPIRES] = otpExpires;

  if (existingIdx !== -1) {
    sheet.getRange(existingIdx + 1, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }

  if (viaGoogle) {
    notifyAdminsNewSolicitud(nombre + ' ' + apellido, rol);
    return { status: 'ok', accountStatus: status, codigo: codigo, email: email, nombre: nombre, rol: rol };
  }

  sendOtpEmail(email, nombre, otpCode, lang);
  return { status: 'ok', accountStatus: status, email: email, needsVerification: true };
}

function resendOtp(p) {
  var email = String(p.email || '').trim().toLowerCase();
  if (!email) throw new Error('No email');
  var cache = CacheService.getScriptCache();
  var cooldownKey = 'otp_cooldown_' + email;
  if (cache.get(cooldownKey)) throw new Error('Espera antes de pedir otro código');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByEmail(rows, email);
  if (idx === -1) throw new Error('No encontrado');
  var row = rows[idx];
  if (statusOf(row) !== 'pending_verification') throw new Error('Ya verificado');

  var otpCode = randomDigits(6);
  var otpExpires = String(Date.now() + OTP_TTL_MINUTES * 60000);
  sheet.getRange(idx + 1, USR_COL.OTP_CODE + 1).setValue(otpCode);
  sheet.getRange(idx + 1, USR_COL.OTP_EXPIRES + 1).setValue(otpExpires);
  cache.put(cooldownKey, '1', OTP_RESEND_COOLDOWN_SECONDS);

  sendOtpEmail(email, String(row[USR_COL.NOMBRE]), otpCode, String(row[USR_COL.LANG] || 'es'));
  return { status: 'ok' };
}

function verifyOtp(p) {
  var email = String(p.email || '').trim().toLowerCase();
  var code = String(p.code || '').trim();
  if (!email || !code) throw new Error('Faltan datos');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByEmail(rows, email);
  if (idx === -1) throw new Error('No encontrado');
  var row = rows[idx];

  if (statusOf(row) !== 'pending_verification') throw new Error('Ya verificado');
  var storedCode = String(row[USR_COL.OTP_CODE] || '').trim();
  var expires = parseInt(row[USR_COL.OTP_EXPIRES]) || 0;
  if (Date.now() > expires) return { status: 'ok', valid: false, expired: true };
  if (storedCode !== code) return { status: 'ok', valid: false, expired: false };

  sheet.getRange(idx + 1, USR_COL.STATUS + 1).setValue('pending_approval');
  sheet.getRange(idx + 1, USR_COL.OTP_CODE + 1).setValue('');
  sheet.getRange(idx + 1, USR_COL.OTP_EXPIRES + 1).setValue('');

  var freshRow = sheet.getRange(idx + 1, 1, 1, USR_COL.OTP_EXPIRES + 1).getValues()[0];
  notifyAdminsNewSolicitud(String(row[USR_COL.NOMBRE]) + ' ' + String(row[USR_COL.APELLIDO]), String(row[USR_COL.ROL]));
  return buildAuthPayload(freshRow);
}

/* ── LOGIN POR CONTRASEÑA ── */
function loginPassword(p) {
  var email = String(p.email || '').trim().toLowerCase();
  var password = String(p.password || '');
  if (!email || !password) throw new Error('Faltan datos');

  if (pinBloqueado('email_' + email)) {
    return { status: 'error', valid: false, blocked: true,
             message: 'Demasiados intentos fallidos. Espera ' + BLOQUEO_MINUTOS + ' minutos.' };
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByEmail(rows, email);
  if (idx === -1) {
    registrarIntentoFallido('email_' + email);
    return { status: 'ok', valid: false };
  }
  var row = rows[idx];
  var status = statusOf(row);

  if (status === 'pending_verification') return { status: 'ok', valid: false, needsVerification: true, email: email };
  if (status === 'pending_approval')      return buildAuthPayload(row); // accountStatus lleva la info, el frontend decide la pantalla
  if (status === 'rejected')              return { status: 'ok', valid: false, rejected: true };
  if (status === 'suspended')             return { status: 'ok', valid: false, suspended: true };
  // 'deleted' (ver adminDeleteUser) se trata como "no existe" — sin motivo
  // específico, por privacidad, y para no dejar que una contraseña
  // conocida siga entrando en una cuenta borrada.
  if (status === 'deleted') { registrarIntentoFallido('email_' + email); return { status: 'ok', valid: false }; }

  var hash = hashPassword(password, String(row[USR_COL.PASSWORD_SALT]));
  if (hash !== String(row[USR_COL.PASSWORD_HASH])) {
    registrarIntentoFallido('email_' + email);
    return { status: 'ok', valid: false };
  }
  limpiarIntentosFallidos('email_' + email);
  return buildAuthPayload(row);
}

/* ── LOGIN / REGISTRO CON GOOGLE ──
 * El frontend obtiene un ID-token de Google Identity Services y lo manda
 * aquí; lo verificamos contra el endpoint público de Google (no hace falta
 * ningún secreto/client-secret para esto, solo comprobar firma+audiencia). */
function googleLogin(p) {
  var idToken = String(p.idToken || '').trim();
  if (!idToken) throw new Error('No token');
  if (!GOOGLE_CLIENT_ID) throw new Error('Google Sign-In no configurado en el backend');

  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Token de Google inválido');
  var info = JSON.parse(resp.getContentText());

  if (info.aud !== GOOGLE_CLIENT_ID) throw new Error('Token de Google no corresponde a esta app');
  if (info.email_verified !== 'true' && info.email_verified !== true) throw new Error('Email de Google no verificado');

  var email = String(info.email || '').trim().toLowerCase();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByEmail(rows, email);

  if (idx === -1) {
    return {
      status: 'ok', valid: false, needsRegistration: true,
      prefill: { email: email, nombre: info.given_name || '', apellido: info.family_name || '' },
      googleSub: info.sub
    };
  }

  var row = rows[idx];
  var status = statusOf(row);
  if (status === 'rejected')  return { status: 'ok', valid: false, rejected: true };
  if (status === 'suspended') return { status: 'ok', valid: false, suspended: true };
  // 'deleted' (ver adminDeleteUser): se ofrece registrar de nuevo, igual
  // que si el email nunca hubiera existido — no delatamos que existió.
  if (status === 'deleted') {
    return {
      status: 'ok', valid: false, needsRegistration: true,
      prefill: { email: email, nombre: info.given_name || '', apellido: info.family_name || '' },
      googleSub: info.sub
    };
  }

  if (!String(row[USR_COL.GOOGLE_SUB] || '').trim()) {
    sheet.getRange(idx + 1, USR_COL.GOOGLE_SUB + 1).setValue(String(info.sub || ''));
  }
  return buildAuthPayload(row);
}

/* ── ESTADO LIGERO (polling desde la pantalla de espera / revalidación de sesión) ── */
function getStatusFor(p) {
  var codigo = String(p.codigo || '').trim();
  if (!codigo) throw new Error('No codigo');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByCodigo(rows, codigo);
  if (idx === -1) return { status: 'ok', valid: false };
  return buildAuthPayload(rows[idx]);
}

/* ── ADMIN: gestión de usuarios ── */
function requireAdmin(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');
  return auth;
}

function adminListUsers(p) {
  requireAdmin(p);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!String(row[USR_COL.NOMBRE] || '').trim() && !String(row[USR_COL.EMAIL] || '').trim()) continue;
    var status = statusOf(row);
    if (status === 'deleted') continue; // soft-deleted (ver adminDeleteUser) — no se listan por defecto
    list.push({
      codigo: String(row[USR_COL.CODIGO] || '').trim(),
      rol: String(row[USR_COL.ROL] || '').trim(),
      nombre: String(row[USR_COL.NOMBRE] || '').trim(),
      apellido: String(row[USR_COL.APELLIDO] || '').trim(),
      email: String(row[USR_COL.EMAIL] || '').trim(),
      telefono: String(row[USR_COL.TELEFONO] || '').trim(),
      obras: String(row[USR_COL.OBRAS] || '').trim(),
      status: status,
      hasPassword: !!String(row[USR_COL.PASSWORD_HASH] || '').trim(),
      viaGoogle: !!String(row[USR_COL.GOOGLE_SUB] || '').trim()
    });
  }
  return { status: 'ok', users: list };
}

function adminApproveUser(p) {
  requireAdmin(p);
  // BUG EVITADO: p.codigo ya lo consume requireAdmin (es el PIN del propio
  // admin que llama). El usuario objetivo va en un campo distinto —
  // targetCodigo — si no, esto "aprobaría" la cuenta del propio admin.
  var codigo = String(p.targetCodigo || '').trim();
  if (!codigo) throw new Error('No codigo');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByCodigo(rows, codigo);
  if (idx === -1) throw new Error('Usuario no encontrado');
  var row = rows[idx];

  sheet.getRange(idx + 1, USR_COL.STATUS + 1).setValue('active');
  sheet.getRange(idx + 1, USR_COL.ACTIVO + 1).setValue('TRUE');
  if (p.obras !== undefined) sheet.getRange(idx + 1, USR_COL.OBRAS + 1).setValue(String(p.obras));
  if (p.rol) sheet.getRange(idx + 1, USR_COL.ROL + 1).setValue(String(p.rol));
  if (p.newCodigo) {
    var newCodigo = String(p.newCodigo).trim();
    if (findUserRowByCodigo(rows, newCodigo) !== -1) throw new Error('Ese código ya está en uso');
    sheet.getRange(idx + 1, USR_COL.CODIGO + 1).setValue(newCodigo);
    codigo = newCodigo;
  }

  var lang = String(row[USR_COL.LANG] || 'es');
  var email = String(row[USR_COL.EMAIL] || '').trim();
  var nombre = String(row[USR_COL.NOMBRE] || '');
  try { if (email) sendUserStatusEmail(email, nombre, lang, true); } catch(e) { Logger.log('email error: ' + e.message); }
  try {
    sendPushLocalized([codigo], 'user_' + codigo + '_approved', function(l) {
      return { title: PUSH_TEXTS[l].cuenta_aprobada_title, body: PUSH_TEXTS[l].cuenta_aprobada(), url: BASE_URL };
    });
  } catch(e) { Logger.log('push error: ' + e.message); }

  return { status: 'ok' };
}

function adminRejectUser(p) {
  requireAdmin(p);
  var codigo = String(p.targetCodigo || '').trim();
  if (!codigo) throw new Error('No codigo');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByCodigo(rows, codigo);
  if (idx === -1) throw new Error('Usuario no encontrado');
  var row = rows[idx];

  sheet.getRange(idx + 1, USR_COL.STATUS + 1).setValue('rejected');
  sheet.getRange(idx + 1, USR_COL.ACTIVO + 1).setValue('FALSE');

  var lang = String(row[USR_COL.LANG] || 'es');
  var email = String(row[USR_COL.EMAIL] || '').trim();
  var nombre = String(row[USR_COL.NOMBRE] || '');
  try { if (email) sendUserStatusEmail(email, nombre, lang, false); } catch(e) { Logger.log('email error: ' + e.message); }
  try {
    sendPushLocalized([codigo], 'user_' + codigo + '_rejected', function(l) {
      return { title: PUSH_TEXTS[l].cuenta_rechazada_title, body: PUSH_TEXTS[l].cuenta_rechazada() };
    });
  } catch(e) { Logger.log('push error: ' + e.message); }

  return { status: 'ok' };
}

function adminUpdateUser(p) {
  requireAdmin(p);
  var codigo = String(p.targetCodigo || '').trim();
  if (!codigo) throw new Error('No codigo');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByCodigo(rows, codigo);
  if (idx === -1) throw new Error('Usuario no encontrado');

  if (p.rol) sheet.getRange(idx + 1, USR_COL.ROL + 1).setValue(String(p.rol));
  if (p.nombre !== undefined) sheet.getRange(idx + 1, USR_COL.NOMBRE + 1).setValue(String(p.nombre).trim());
  if (p.apellido !== undefined) sheet.getRange(idx + 1, USR_COL.APELLIDO + 1).setValue(String(p.apellido).trim());
  if (p.obras !== undefined) sheet.getRange(idx + 1, USR_COL.OBRAS + 1).setValue(String(p.obras));
  if (p.email !== undefined) sheet.getRange(idx + 1, USR_COL.EMAIL + 1).setValue(String(p.email).trim());
  if (p.telefono !== undefined) sheet.getRange(idx + 1, USR_COL.TELEFONO + 1).setValue(String(p.telefono).trim());
  if (p.status) {
    sheet.getRange(idx + 1, USR_COL.STATUS + 1).setValue(String(p.status));
    sheet.getRange(idx + 1, USR_COL.ACTIVO + 1).setValue(p.status === 'active' ? 'TRUE' : 'FALSE');
  }
  if (p.newCodigo) {
    var newCodigo = String(p.newCodigo).trim();
    if (newCodigo !== codigo) {
      if (findUserRowByCodigo(rows, newCodigo) !== -1) throw new Error('Ese código ya está en uso');
      sheet.getRange(idx + 1, USR_COL.CODIGO + 1).setValue(newCodigo);
    }
  }
  return { status: 'ok' };
}

function adminSetUserCode(p) {
  requireAdmin(p);
  var codigo = String(p.targetCodigo || '').trim();
  var newCodigo = String(p.newCodigo || '').trim();
  if (!codigo || !newCodigo) throw new Error('Faltan datos');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  if (findUserRowByCodigo(rows, newCodigo) !== -1) throw new Error('Ese código ya está en uso');
  var idx = findUserRowByCodigo(rows, codigo);
  if (idx === -1) throw new Error('Usuario no encontrado');
  sheet.getRange(idx + 1, USR_COL.CODIGO + 1).setValue(newCodigo);
  return { status: 'ok', codigo: newCodigo };
}

function adminResetPassword(p) {
  requireAdmin(p);
  var codigo = String(p.targetCodigo || '').trim();
  if (!codigo) throw new Error('No codigo');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByCodigo(rows, codigo);
  if (idx === -1) throw new Error('Usuario no encontrado');
  var row = rows[idx];

  var tempPassword = randomDigits(8);
  var salt = randomSalt();
  sheet.getRange(idx + 1, USR_COL.PASSWORD_HASH + 1).setValue(hashPassword(tempPassword, salt));
  sheet.getRange(idx + 1, USR_COL.PASSWORD_SALT + 1).setValue(salt);

  var email = String(row[USR_COL.EMAIL] || '').trim();
  var nombre = String(row[USR_COL.NOMBRE] || '');
  var lang = String(row[USR_COL.LANG] || 'es');
  if (email) {
    var l = (lang === 'ru' || lang === 'en') ? lang : 'es';
    var subjects = { es: 'Tu nueva contraseña temporal — AEDIS', ru: 'Новый временный пароль — AEDIS', en: 'Your temporary password — AEDIS' };
    var bodies = {
      es: 'Hola ' + nombre + ',\n\nUn administrador ha restablecido tu contraseña. Nueva contraseña temporal: ' + tempPassword + '\n\nTe recomendamos cambiarla después de iniciar sesión.',
      ru: 'Здравствуйте, ' + nombre + '!\n\nАдминистратор сбросил ваш пароль. Новый временный пароль: ' + tempPassword + '\n\nРекомендуем сменить его после входа.',
      en: 'Hi ' + nombre + ',\n\nAn admin reset your password. Temporary password: ' + tempPassword + '\n\nWe recommend changing it after logging in.'
    };
    MailApp.sendEmail({ to: email, subject: subjects[l], body: bodies[l] });
  }
  return { status: 'ok', emailed: !!email };
}

// Soft-delete (mismo criterio que STATUS='deleted' en PARTE DE TRABAJO,
// ver deleteRecord más abajo): la fila nunca se borra físicamente, solo
// deja de aparecer en adminListUsers() por defecto. Si el código volviera
// a usarse en algún login (checkUser/loginPassword/getStatusFor), un
// usuario 'deleted' se trata igual que 'suspended'/'rejected' — no entra.
function adminDeleteUser(p) {
  requireAdmin(p);
  var codigo = String(p.targetCodigo || '').trim();
  if (!codigo) throw new Error('No codigo');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  var rows = sheet.getDataRange().getValues();
  var idx = findUserRowByCodigo(rows, codigo);
  if (idx === -1) throw new Error('Usuario no encontrado');

  sheet.getRange(idx + 1, USR_COL.STATUS + 1).setValue('deleted');
  sheet.getRange(idx + 1, USR_COL.ACTIVO + 1).setValue('FALSE');
  return { status: 'ok' };
}

/* ── PARES CLIENTE:OBRA reales (selector de "objetos" del admin) ──
 * getListsData() ya deduplica CLIENTE y OBRA como listas planas
 * independientes — aquí se devuelven los pares tal y como existen fila a
 * fila en la hoja 'servicio', para que el admin no pueda formar una
 * combinación cliente/obra inválida. */
function getClienteObraPairs(p) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SERVICIO);
  if (!sheet) return { status: 'ok', pairs: [] };
  var rows = sheet.getDataRange().getValues();
  var seen = {};
  var pairs = [];
  for (var i = 1; i < rows.length; i++) {
    var cliente = String(rows[i][0] || '').trim();
    var obra = String(rows[i][1] || '').trim();
    if (!cliente || !obra) continue;
    var key = cliente + '::' + obra;
    if (seen[key]) continue;
    seen[key] = true;
    pairs.push({ cliente: cliente, obra: obra });
  }
  return { status: 'ok', pairs: pairs };
}

/* ════════ PUSH NOTIFICATIONS (OneSignal) ════════
   El frontend hace OneSignal.login(PIN) al iniciar sesión, así que el
   external_id en OneSignal es exactamente el código PIN del usuario.
   Basta con enviar el push a ese external_id. */

// Envía un push a uno o varios external_id (códigos PIN) vía OneSignal REST API.
function sendPushOneSignal(externalIds, title, body, notifId, subtitle, url) {
  if (!externalIds || !externalIds.length) return;
  var ids = externalIds.filter(function(x){ return x; }).map(String);
  if (!ids.length) return;

  // BUG CORREGIDO ("tocar una notificación con la app YA ABIERTA en
  // primer plano no hace nada"): "url" solo lo usa OneSignal cuando abre
  // una ventana nueva (app cerrada) — si el cliente ya está en pantalla,
  // el propio SDK simplemente le da foco sin navegar, así que el
  // deep-link de la URL nunca llega a leerse. El frontend ahora escucha
  // el evento de click directamente (OneSignal.Notifications.addEventListener
  // en index.html) y necesita el ID/modo como datos estructurados, no
  // como una URL que tendría que volver a parsear — se extraen aquí una
  // sola vez, a partir de la misma URL que ya se construye con
  // buildAppUrl(id, mode), para no duplicar esa lógica en cada llamador.
  var finalUrl = url || BASE_URL;
  var reportId = '', mode = '';
  var qIndex = finalUrl.indexOf('?');
  if (qIndex !== -1) {
    finalUrl.substring(qIndex + 1).split('&').forEach(function(pair) {
      var kv = pair.split('=');
      if (kv[0] === 'openReport') reportId = decodeURIComponent(kv[1] || '');
      if (kv[0] === 'mode') mode = decodeURIComponent(kv[1] || '');
    });
  }

  var payload = {
    app_id: ONESIGNAL_APP_ID,
    include_external_user_ids: ids,
    channel_for_external_user_ids: 'push',
    headings: { en: title, es: title },
    contents: { en: body, es: body },
    data: { notifId: notifId || '', reportId: reportId, mode: mode },
    // "url" es lo que OneSignal usa al tocar la notificación — sin esto
    // abría la raíz del dominio (404, ver comentario en BASE_URL).
    url: finalUrl,
    // BUG CORREGIDO ("con la app cerrada/pantalla apagada, las
    // notificaciones no llegan de forma fiable — a veces ni con un
    // informe nuevo"): sin "priority" el push viaja con prioridad normal
    // en FCM/Android, que el propio sistema operativo puede retrasar o
    // agrupar cuando el dispositivo está inactivo — 10 es la prioridad
    // máxima documentada por OneSignal, pensada justo para este caso.
    priority: 10
    // ios_badgeType/ios_badgeCount убраны намеренно: бейдж на иконке
    // управляется только фронтом через navigator.setAppBadge() с реальным
    // числом непрочитанных (updateAppIconBadge en index.html). Si dejamos
    // que el badge lo controle también aquí, y también el front, ambos
    // acaban desincronizados y el badge se queda "pegado".
  };
  // "subtitle" — probado en vivo el 2026-07-28: rellenarlo con un espacio
  // NO evita que iOS siga mostrando su propio "from AEDIS" debajo (el
  // usuario lo confirmó con una captura real) — es texto de Safari/PWA,
  // fuera del control de este payload cuando no se manda contenido real.
  // Revertido a como estaba: solo se manda si un llamador da texto de
  // verdad. El "una sola mención de AEDIS" que pidió el usuario se
  // resuelve en el TÍTULO en su lugar (ver pushTitle/las 4 llamadas que
  // usaban el genérico "AEDIS" como título — ahora tienen un título
  // propio, así "AEDIS" ya no aparece dos veces).
  if (subtitle) payload.subtitle = { en: subtitle, es: subtitle };

  // BUG CORREGIDO (la causa más probable de "a veces sí, a veces no"):
  // con muteHttpExceptions:true, UrlFetchApp NUNCA lanza excepción por un
  // código de error HTTP (4xx/5xx) — solo por un fallo real de red. El
  // código anterior hacía "return" nada más recibir CUALQUIER respuesta,
  // sin mirar su código — así que un 429 (límite de tasa) o un 5xx
  // transitorio de OneSignal se registraba en el log pero se daba por
  // "enviado con éxito" sin reintentar nunca, aunque el push nunca
  // llegara. Ahora solo un código 2xx cuenta como éxito; cualquier otra
  // cosa entra en el mismo reintento con backoff que ya existía para los
  // fallos de red.
  var lastError = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var response = UrlFetchApp.fetch('https://api.onesignal.com/notifications', {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        headers: { 'Authorization': 'Key ' + ONESIGNAL_API_KEY },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = response.getResponseCode();
      var bodyText = response.getContentText();
      Logger.log('OneSignal response code: ' + code);
      Logger.log('OneSignal response body: ' + bodyText);
      if (code >= 200 && code < 300) return; // éxito real — salimos de la función
      lastError = new Error('HTTP ' + code + ': ' + bodyText);
      Logger.log('Intento ' + (attempt + 1) + ' devolvió error HTTP ' + code);
    } catch(e) {
      lastError = e;
      Logger.log('Intento ' + (attempt + 1) + ' falló: ' + e.message);
    }
    if (attempt < 2) Utilities.sleep(800);
  }
  if (lastError) {
    Logger.log('OneSignal push error tras 3 intentos: ' + lastError.message);
  }
}

/* ── QUIÉN envía el push: título en NEGRITA/GRANDE por convención del
 * propio SO (headings de OneSignal), pedido explícito para que el
 * destinatario sepa de un vistazo quién generó el aviso sin tener que
 * abrir la notificación — "Operario MOHA" / "Manager Carlos" / "Admin
 * Ana", nunca el genérico "AEDIS" salvo cuando el push es una
 * confirmación del propio sistema hacia uno mismo (ver 'enviado' más
 * abajo), donde no hay ningún "otro" al que atribuir la acción. */
var ROLE_LABELS = {
  es: { operario: 'Operario', manager: 'Manager', admin: 'Admin' },
  ru: { operario: 'Рабочий',  manager: 'Менеджер', admin: 'Админ' },
  en: { operario: 'Worker',   manager: 'Manager',  admin: 'Admin' }
};
function pushTitle(lang, rol, nombre) {
  var labels = ROLE_LABELS[lang] || ROLE_LABELS.es;
  var label = labels[rol];
  return (label && nombre) ? (label + ' ' + nombre) : 'AEDIS';
}

/* ── PUSH LOCALIZADO: cada destinatario recibe el texto en SU idioma ──
 * (columna F de USUARIOS, guardada por setUserLang() cuando el usuario
 * cambia de idioma en la app). Agrupamos los PIN por idioma y hacemos
 * una llamada a sendPushOneSignal() por cada grupo no vacío. El body ya
 * NO repite quién hizo la acción (eso vive en el título, ver pushTitle
 * arriba) — solo dice QUÉ pasó y CON QUÉ informe/objeto. */
// enviado_title: la única notificación sin "actor" (es el sistema
// confirmándole al propio operario que su acción se guardó) — para que
// visualmente encaje con el mismo formato "titular en negrita + detalle
// abajo" que todas las demás, en vez de usar el genérico "AEDIS" también
// aquí, el titular es el propio resultado ("Informe enviado").
// Mismo criterio 2026-07-28 para las otras 4 notificaciones que también
// usaban el "AEDIS" genérico como título: en iOS, debajo del título
// Safari añade su propio "from AEDIS" (confirmado en vivo, no se puede
// quitar desde aquí — ver sendPushOneSignal) — así que un título
// literalmente igual a "AEDIS" hacía que la palabra saliera dos veces
// seguidas. Pedido explícito: una sola mención. Título propio para cada
// una en vez del genérico.
var PUSH_TEXTS = {
  es: {
    enviado_title: 'Informe enviado',
    nueva_solicitud_title: 'Nueva solicitud',
    precio_cambiado_title: 'Precio actualizado',
    cuenta_aprobada_title: 'Cuenta aprobada',
    cuenta_rechazada_title: 'Solicitud no aprobada',
    nuevo:            function(id, cliente, obra) { return 'Creó un nuevo informe ' + id + ' — ' + cliente + ' · ' + obra; },
    enviado:          function(id, cliente, obra) { return 'Enviado el informe ' + id + ' — ' + cliente + ' · ' + obra; },
    aprobado_tu:      function(id, cliente, obra) { return 'Aprobó tu informe ' + id + ' — ' + cliente + ' · ' + obra; },
    aprobado_de:      function(id, operario, cliente, obra) { return 'Aprobó el informe ' + id + ' de ' + operario + ' — ' + cliente + ' · ' + obra; },
    rechazado_tu:     function(id, cliente, obra, comentario) { return 'Rechazó tu informe ' + id + ' — ' + cliente + ' · ' + obra + (comentario ? ': ' + comentario : ''); },
    rechazado_de:     function(id, operario, cliente, obra, comentario) { return 'Rechazó el informe ' + id + ' de ' + operario + ' — ' + cliente + ' · ' + obra + (comentario ? ': ' + comentario : ''); },
    editado_rechazado: function(id, cliente, obra) { return 'Corrigió y reenvió el informe rechazado ' + id + ' — ' + cliente + ' · ' + obra; },
    editado_pending:   function(id, cliente, obra) { return 'Actualizó el informe ' + id + ' pendiente de revisión — ' + cliente + ' · ' + obra; },
    eliminado:        function(id, cliente, obra) { return 'Eliminó el informe ' + id + ' — ' + cliente + ' · ' + obra; },
    nueva_solicitud:  function(nombreCompleto, rol) { return 'Nueva solicitud de registro: ' + nombreCompleto + ' (' + rol + ')'; },
    precio_cambiado:  function(grupos) {
      var total = grupos.reduce(function(s,g){ return s + g.ids.length; }, 0);
      var partes = grupos.map(function(g){
        var etiqueta = g.campo === 'materiales' ? 'Materiales' : 'Tarifa/h';
        var unidad = g.campo === 'materiales' ? ' €' : ' €/h';
        return etiqueta + ' ' + parseFloat(g.valor).toFixed(2) + unidad + ' → ' + g.ids.join(', ');
      });
      return 'Precio actualizado en ' + total + ' informe(s) aprobado(s): ' + partes.join(' · ');
    },
    cuenta_aprobada:  function() { return 'Tu cuenta ha sido aprobada. Ya puedes iniciar sesión.'; },
    cuenta_rechazada: function() { return 'Tu solicitud de acceso no ha sido aprobada.'; }
  },
  ru: {
    enviado_title: 'Отчёт отправлен',
    nueva_solicitud_title: 'Новая заявка',
    precio_cambiado_title: 'Цена обновлена',
    cuenta_aprobada_title: 'Аккаунт одобрен',
    cuenta_rechazada_title: 'Заявка не одобрена',
    nuevo:            function(id, cliente, obra) { return 'Создал новый отчёт ' + id + ' — ' + cliente + ' · ' + obra; },
    enviado:          function(id, cliente, obra) { return 'Отправлен отчёт ' + id + ' — ' + cliente + ' · ' + obra; },
    aprobado_tu:      function(id, cliente, obra) { return 'Согласовал ваш отчёт ' + id + ' — ' + cliente + ' · ' + obra; },
    aprobado_de:      function(id, operario, cliente, obra) { return 'Согласовал отчёт ' + id + ' от ' + operario + ' — ' + cliente + ' · ' + obra; },
    rechazado_tu:     function(id, cliente, obra, comentario) { return 'Не согласовал ваш отчёт ' + id + ' — ' + cliente + ' · ' + obra + (comentario ? ': ' + comentario : ''); },
    rechazado_de:     function(id, operario, cliente, obra, comentario) { return 'Не согласовал отчёт ' + id + ' от ' + operario + ' — ' + cliente + ' · ' + obra + (comentario ? ': ' + comentario : ''); },
    editado_rechazado: function(id, cliente, obra) { return 'Исправил и повторно отправил отклонённый отчёт ' + id + ' — ' + cliente + ' · ' + obra; },
    editado_pending:   function(id, cliente, obra) { return 'Обновил ещё не проверенный отчёт ' + id + ' — ' + cliente + ' · ' + obra; },
    eliminado:        function(id, cliente, obra) { return 'Удалил отчёт ' + id + ' — ' + cliente + ' · ' + obra; },
    nueva_solicitud:  function(nombreCompleto, rol) { return 'Новая заявка на регистрацию: ' + nombreCompleto + ' (' + rol + ')'; },
    precio_cambiado:  function(grupos) {
      var total = grupos.reduce(function(s,g){ return s + g.ids.length; }, 0);
      var partes = grupos.map(function(g){
        var etiqueta = g.campo === 'materiales' ? 'Материалы' : 'Ставка/ч';
        var unidad = g.campo === 'materiales' ? ' €' : ' €/ч';
        return etiqueta + ' ' + parseFloat(g.valor).toFixed(2) + unidad + ' → ' + g.ids.join(', ');
      });
      return 'Цена обновлена в ' + total + ' согласованном(ых) отчёте(ах): ' + partes.join(' · ');
    },
    cuenta_aprobada:  function() { return 'Ваш аккаунт одобрен. Теперь вы можете войти.'; },
    cuenta_rechazada: function() { return 'Ваша заявка на доступ не была одобрена.'; }
  },
  en: {
    enviado_title: 'Report sent',
    nueva_solicitud_title: 'New request',
    precio_cambiado_title: 'Price updated',
    cuenta_aprobada_title: 'Account approved',
    cuenta_rechazada_title: 'Request not approved',
    nuevo:            function(id, cliente, obra) { return 'Created a new report ' + id + ' — ' + cliente + ' · ' + obra; },
    enviado:          function(id, cliente, obra) { return 'Sent report ' + id + ' — ' + cliente + ' · ' + obra; },
    aprobado_tu:      function(id, cliente, obra) { return 'Approved your report ' + id + ' — ' + cliente + ' · ' + obra; },
    aprobado_de:      function(id, operario, cliente, obra) { return 'Approved the report ' + id + ' from ' + operario + ' — ' + cliente + ' · ' + obra; },
    rechazado_tu:     function(id, cliente, obra, comentario) { return 'Rejected your report ' + id + ' — ' + cliente + ' · ' + obra + (comentario ? ': ' + comentario : ''); },
    rechazado_de:     function(id, operario, cliente, obra, comentario) { return 'Rejected the report ' + id + ' from ' + operario + ' — ' + cliente + ' · ' + obra + (comentario ? ': ' + comentario : ''); },
    editado_rechazado: function(id, cliente, obra) { return 'Corrected and resent the rejected report ' + id + ' — ' + cliente + ' · ' + obra; },
    editado_pending:   function(id, cliente, obra) { return 'Updated the still-pending report ' + id + ' — ' + cliente + ' · ' + obra; },
    eliminado:        function(id, cliente, obra) { return 'Deleted the report ' + id + ' — ' + cliente + ' · ' + obra; },
    nueva_solicitud:  function(nombreCompleto, rol) { return 'New registration request: ' + nombreCompleto + ' (' + rol + ')'; },
    precio_cambiado:  function(grupos) {
      var total = grupos.reduce(function(s,g){ return s + g.ids.length; }, 0);
      var partes = grupos.map(function(g){
        var etiqueta = g.campo === 'materiales' ? 'Materials' : 'Rate/h';
        var unidad = g.campo === 'materiales' ? ' €' : ' €/h';
        return etiqueta + ' ' + parseFloat(g.valor).toFixed(2) + unidad + ' → ' + g.ids.join(', ');
      });
      return 'Price updated on ' + total + ' approved report(s): ' + partes.join(' · ');
    },
    cuenta_aprobada:  function() { return 'Your account has been approved. You can now log in.'; },
    cuenta_rechazada: function() { return 'Your access request was not approved.'; }
  }
};

// Lee la columna F (idioma) de USUARIOS UNA sola vez y devuelve un mapa
// PIN → 'es'/'ru'/'en' (por defecto 'es' si está vacío o el PIN no aparece).
function getLangsForPins(pins) {
  var map = {};
  pins.forEach(function(pin){ map[pin] = 'es'; });
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  if (!sheet) return map;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var pin = String(rows[i][0]).trim();
    if (map.hasOwnProperty(pin)) {
      var lang = String(rows[i][5] || '').trim().toLowerCase();
      map[pin] = (lang === 'ru' || lang === 'en') ? lang : 'es';
    }
  }
  return map;
}

// pins: array de PIN destinatarios. notifId: mismo para todos (dedupe en
// el frontend). textFn(lang) debe devolver { title, body, subtitle? } para
// ese idioma — subtitle es opcional (ver sendPushOneSignal: sustituye el
// "from AEDIS" que pone Safari por defecto en iOS).
function sendPushLocalized(pins, notifId, textFn) {
  if (!pins || !pins.length) return;
  var langMap = getLangsForPins(pins);
  var groups = { es: [], ru: [], en: [] };
  pins.forEach(function(pin){ groups[langMap[pin] || 'es'].push(pin); });
  Object.keys(groups).forEach(function(lang){
    if (!groups[lang].length) return;
    var texts = textFn(lang);
    sendPushOneSignal(groups[lang], texts.title, texts.body, notifId, texts.subtitle, texts.url);
  });
}

// Busca el código PIN (external_id) de un operario por su nombre
function getPinByNombre(nombre) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  if (!sheet) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][2]).trim() === String(nombre).trim()) {
      return String(rows[i][0]).trim();
    }
  }
  return null;
}

// Devuelve los códigos PIN de todos los administradores activos
function getAdminPins() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var pins = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var rol = String(r[1]).trim();
    var activo = String(r[4]).trim().toUpperCase();
    if (rol === 'admin' && activo === 'TRUE') pins.push(String(r[0]).trim());
  }
  return pins;
}

// Devuelve los códigos PIN de todos los managers/admins con acceso a un cliente:obra dado
function getPinsWithAccess(cliente, obra) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USUARIOS);
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var pins = [];

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var rol = String(r[1]).trim();
    var activo = String(r[4]).trim().toUpperCase();
    if (activo !== 'TRUE') continue;
    if (rol !== 'manager' && rol !== 'admin') continue;

    var obrasRaw = String(r[3]).trim();
    var hasAccess = false;
    if (obrasRaw === '*') {
      hasAccess = true;
    } else {
      obrasRaw.split(',').forEach(function(pair){
        var parts = pair.split(':');
        if (parts.length !== 2) return;
        var gc = parts[0].trim(), go = parts[1].trim();
        if ((gc === '*' || gc === cliente) && (go === '*' || go === obra)) hasAccess = true;
      });
    }
    if (hasAccess) pins.push(String(r[0]).trim());
  }
  return pins;
}

/* ── ID GENERATOR ── */
function nextId() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_COUNTER);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_COUNTER);
  var last = parseInt(sheet.getRange(2,1).getValue()) || 0;
  var next = last + 1;
  sheet.getRange(2,1).setValue(next);
  return 'PT-' + ('0000' + next).slice(-4);
}

/* ── SAVE REPORT (рабочий отправляет отчёт — пишется сразу в PARTE DE TRABAJO) ──
 * BUG CORREGIDO (seguridad): esta función no verificaba el PIN en absoluto
 * — confiaba ciegamente en el campo "operario" que mandaba el propio
 * cliente. Como WEBAPP_URL es visible en el código fuente de la página,
 * cualquiera podía enviar un POST fabricado con cualquier nombre de
 * operario, sin conocer ningún PIN. Ahora se exige un PIN válido de rol
 * operario, y el nombre del operario SIEMPRE sale de checkUser() (lo que
 * dice el PIN), nunca de lo que mande el cliente. */
function saveReport(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'operario') throw new Error('No autorizado');

  var d;
  if (p.data) {
    try { d = JSON.parse(p.data); }
    catch(e) { d = JSON.parse(decodeURIComponent(p.data)); }
  } else {
    d = p;
  }
  d.operario = auth.nombre; // nunca confiar en el nombre que manda el cliente

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_PARTE);

  var horas  = parseInt(d.horas)    || 0;
  var precio = parseFloat(d.precio) || 0;
  var total  = horas * PRICE_PER_HOUR + precio;
  var id     = nextId();
  var now    = new Date();

  sheet.appendRow([
    id, 'pending',
    sanitizeCell(d.fecha), sanitizeCell(d.cliente), sanitizeCell(d.obra), sanitizeCell(d.operario),
    sanitizeCell(d.ayudante), sanitizeCell(d.vehiculo), sanitizeCell(d.trabajos), d.photos_obra || '',
    sanitizeCell(d.tipo), horas, sanitizeCell(d.compania), sanitizeCell(d.materiales), d.photos_mat || '',
    precio, total, now, '', '', ''
  ]);

  appendServicioClienteObra(d.cliente, d.obra);
  Logger.log('✅ Informe creado: ' + id);
  // Telegram desactivado — las notificaciones push (OneSignal) ya cubren
  // este aviso y muestran más contexto directamente en el propio push.
  // Para reactivar Telegram, descomenta la línea siguiente.
  // try { notifyBobNewReport(id, d, horas, precio, total); } catch(e) { Logger.log('TG notify error: ' + e.message); }
  try {
    var mgrPins = getPinsWithAccess(d.cliente || '', d.obra || '');
    var adminPins = getAdminPins();
    var allPins = mgrPins.concat(adminPins).filter(function(v,i,a){ return a.indexOf(v)===i; });
    sendPushLocalized(allPins, id + '_new', function(lang) {
      return {
        title: pushTitle(lang, 'operario', d.operario || ''),
        body: PUSH_TEXTS[lang].nuevo(id, d.cliente || '', d.obra || ''),
        url: buildAppUrl(id, 'view')
      };
    });
  } catch(e) { Logger.log('Push notify error: ' + e.message); }
  // Confirmación al propio operario que envió el informe — antes solo se
  // avisaba a managers/admins y el trabajador se quedaba sin ninguna
  // señal de que su envío había llegado bien.
  try {
    var senderPin = getPinByNombre(d.operario || '');
    if (senderPin) {
      sendPushLocalized([senderPin], id + '_sent', function(lang) {
        return { title: PUSH_TEXTS[lang].enviado_title, body: PUSH_TEXTS[lang].enviado(id, d.cliente || '', d.obra || ''), url: buildAppUrl(id, 'view') };
      });
    }
  } catch(e) { Logger.log('Push notify error: ' + e.message); }

  return { status:'ok', id:id, total:total };
}

/* ── ADMIN: crea un informe en nombre propio o de un trabajador concreto
 * (2026-07-28, pedido explícito — "página de creación de informe como la
 * de los trabajadores"). A diferencia de saveReport() (que fuerza
 * operario = auth.nombre, línea "nunca confiar en el nombre que manda el
 * cliente" — esa validación tenía sentido para un operario mandando SU
 * PROPIO informe, pero aquí el admin puede legítimamente crear un
 * informe A NOMBRE de otra persona), esta función SÍ confía en
 * p.operario/d.operario, pero solo porque quien llama ya está
 * autenticado como admin (auth.rol !== 'admin' → rechazado). Escribe en
 * PARTE DE TRABAJO igual que saveReport() (mismo 'pending' inicial —
 * el frontend llama a la acción 'approve' justo después, reutilizando
 * approveRecord() tal cual para copiar a INFORME, en vez de duplicar esa
 * lógica aquí). Sin notificación "informe nuevo" (no tiene sentido, se
 * aprueba casi al instante) — approveRecord() ya manda su propia
 * notificación de aprobación, que se autosuprime si operario===admin. */
function adminSaveReport(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');

  var d;
  if (p.data) {
    try { d = JSON.parse(p.data); }
    catch(e) { d = JSON.parse(decodeURIComponent(p.data)); }
  } else {
    d = p;
  }
  var operarioNombre = String(d.operario || auth.nombre || '').trim();
  if (!operarioNombre) throw new Error('Falta el trabajador');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_PARTE);

  var horas  = parseInt(d.horas)    || 0;
  var precio = parseFloat(d.precio) || 0;
  var total  = horas * PRICE_PER_HOUR + precio;
  var id     = nextId();
  var now    = new Date();

  sheet.appendRow([
    id, 'pending',
    sanitizeCell(d.fecha), sanitizeCell(d.cliente), sanitizeCell(d.obra), sanitizeCell(operarioNombre),
    sanitizeCell(d.ayudante), sanitizeCell(d.vehiculo), sanitizeCell(d.trabajos), '',
    sanitizeCell(d.tipo), horas, sanitizeCell(d.compania), sanitizeCell(d.materiales), '',
    precio, total, now, '', '', ''
  ]);

  appendServicioClienteObra(d.cliente, d.obra);
  Logger.log('✅ Informe creado por admin ' + auth.nombre + ' (trabajador: ' + operarioNombre + '): ' + id);

  return { status:'ok', id:id, total:total };
}

/* ── GET PENDING FOR USER (manager видит свои pares CLIENTE:OBRA, admin видит всё) ── */
function getPendingForUser(p) {
  var auth = checkUser(p);
  if (!auth.valid) return { status:'error', message:'Invalid code' };
  if (auth.rol !== 'manager' && auth.rol !== 'admin') return { status:'error', message:'Rol sin acceso' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var result = [];

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var status = r[1], cliente = r[3], obra = r[4];
    if (status === 'pending' && userCanAccess(auth, cliente, obra)) {
      var rec = {};
      headers.forEach(function(h, idx){ rec[h] = r[idx]; });
      result.push(rec);
    }
  }
  return { status:'ok', data:result, nombre:auth.nombre };
}

/* ── APPROVE: меняет статус в PARTE DE TRABAJO + дублирует в INFORME ── */
function approveRecord(p) {
  var auth = checkUser(p);
  if (!auth.valid || (auth.rol !== 'manager' && auth.rol !== 'admin')) throw new Error('No autorizado');

  var id = p.id;
  if (!id) throw new Error('No id');

  var sheetP = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheetP.getDataRange().getValues();
  var rowIndex = -1, record = null;

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { rowIndex = i + 1; record = rows[i]; break; }
  }
  if (rowIndex === -1) throw new Error('Record not found: ' + id);
  if (!userCanAccess(auth, record[3], record[4])) throw new Error('Sin acceso a este objeto');

  // Дублируем в INFORME — полная копия строки (21 колонка, та же структура, что и PARTE DE TRABAJO)
  var sheetI = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORME);
  if (!sheetI) throw new Error('Sheet not found: ' + SHEET_INFORME);
  var decisionDate = new Date();
  // Orden de columnas de INFORME (ver INFORME_COL): PRECIO_HORA va justo
  // después de HORAS (record[11]), no al final — desplaza el resto de
  // campos de record[] +1 posición respecto a como se escribían antes.
  sheetI.appendRow([
    record[0],            // ID
    'approved',           // STATUS (финальный)
    record[2], record[3], record[4], record[5], record[6], record[7],
    record[8], record[9], record[10], record[11],
    PRICE_PER_HOUR,        // PRECIO_HORA — punto de partida editable a mano en la propia hoja, ver onEdit()
    record[12], record[13], record[14], record[15], record[16],
    record[17],           // TIMESTAMP (исходный, когда рабочий отправил)
    '',                   // COMENTARIO_MANAGER — пусто, т.к. согласовано
    decisionDate,          // FECHA_DECISION
    auth.nombre            // MANAGER_NOMBRE
  ]);

  // Обновляем статус в PARTE DE TRABAJO, очищаем комментарий
  sheetP.getRange(rowIndex, 2).setValue('approved');
  sheetP.getRange(rowIndex, 19).setValue('');           // comentario_manager очищен
  sheetP.getRange(rowIndex, 20).setValue(decisionDate); // fecha_decision
  sheetP.getRange(rowIndex, 21).setValue(auth.nombre);  // manager_nombre

  Logger.log('✅ ' + id + ' aprobado por ' + auth.nombre + ' → copiado a INFORME');

  // Telegram desactivado — ver nota en saveReport(). Para reactivar,
  // descomenta las dos líneas siguientes.
  // try { notifyBobDecision(id, record, 'approved', auth.nombre, ''); } catch(e) { Logger.log('TG error: ' + e.message); }
  // try { notifyOperario(record[5], id, 'approved', ''); } catch(e) { Logger.log('TG operario error: ' + e.message); }
  try {
    // Pedido: el texto debe decir "tu informe" solo a su dueño — a los
    // demás admins que solo observan la decisión les hablamos del
    // informe "de {operario}" en tercera persona. Antes se mandaba el
    // MISMO body a ambos grupos en una sola llamada (ver comentario
    // equivalente ya existente en rejectRecord, aquí replicado).
    var opPin = getPinByNombre(record[5]);
    var adminPins2 = getAdminPins()
      .filter(function(pin){ return pin !== String(p.codigo || '').trim(); })
      .filter(function(pin){ return pin !== opPin; });
    if (opPin && opPin !== String(p.codigo || '').trim()) {
      sendPushLocalized([opPin], id + '_approved_op', function(lang) {
        return {
          title: pushTitle(lang, auth.rol, auth.nombre || ''),
          body: PUSH_TEXTS[lang].aprobado_tu(id, record[3], record[4]),
          url: buildAppUrl(id, 'view')
        };
      });
    }
    if (adminPins2.length) {
      sendPushLocalized(adminPins2, id + '_approved_ad', function(lang) {
        return {
          title: pushTitle(lang, auth.rol, auth.nombre || ''),
          body: PUSH_TEXTS[lang].aprobado_de(id, record[5], record[3], record[4]),
          url: buildAppUrl(id, 'view')
        };
      });
    }
  } catch(e) { Logger.log('Push notify error: ' + e.message); }

  return { status:'ok', id:id, result:'approved' };
}

/* ── REJECT: меняет статус в PARTE DE TRABAJO, заполняет comentario ── */
function rejectRecord(p) {
  var auth = checkUser(p);
  if (!auth.valid || (auth.rol !== 'manager' && auth.rol !== 'admin')) throw new Error('No autorizado');

  var id = p.id;
  var comentario = p.comentario || '';
  if (!id) throw new Error('No id');

  var sheetP = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheetP.getDataRange().getValues();
  var rowIndex = -1, record = null;

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { rowIndex = i + 1; record = rows[i]; break; }
  }
  if (rowIndex === -1) throw new Error('Record not found: ' + id);
  if (!userCanAccess(auth, record[3], record[4])) throw new Error('Sin acceso a este objeto');

  sheetP.getRange(rowIndex, 2).setValue('rejected');
  sheetP.getRange(rowIndex, 19).setValue(comentario);
  sheetP.getRange(rowIndex, 20).setValue(new Date());
  sheetP.getRange(rowIndex, 21).setValue(auth.nombre);

  Logger.log('❌ ' + id + ' rechazado por ' + auth.nombre);

  // Telegram desactivado — ver nota en saveReport(). Para reactivar,
  // descomenta las dos líneas siguientes.
  // try { notifyBobDecision(id, record, 'rejected', auth.nombre, comentario); } catch(e) { Logger.log('TG error: ' + e.message); }
  // try { notifyOperario(record[5], id, 'rejected', comentario); } catch(e) { Logger.log('TG operario error: ' + e.message); }
  try {
    // Al operario dueño del informe rechazado el push lo lleva DIRECTO al
    // formulario de edición (mode=edit) — es la única acción posible para
    // él en ese momento. A managers/admin les lleva al detalle de solo
    // lectura (mode=view) — ellos no editan informes.
    var opPin2 = getPinByNombre(record[5]);
    if (opPin2) {
      sendPushLocalized([opPin2], id + '_rejected_op', function(lang) {
        return {
          title: pushTitle(lang, auth.rol, auth.nombre || ''),
          body: PUSH_TEXTS[lang].rechazado_tu(id, record[3], record[4], comentario),
          url: buildAppUrl(id, 'edit')
        };
      });
    }
    // BUG CORREGIDO: mismo caso que en approveRecord — excluir al propio
    // actor (si es admin) de los destinatarios de su propia decisión.
    var adminPins3 = getAdminPins()
      .filter(function(pin){ return pin !== String(p.codigo || '').trim(); })
      .filter(function(pin){ return pin !== opPin2; });
    if (adminPins3.length) {
      sendPushLocalized(adminPins3, id + '_rejected_ad', function(lang) {
        return {
          title: pushTitle(lang, auth.rol, auth.nombre || ''),
          body: PUSH_TEXTS[lang].rechazado_de(id, record[5], record[3], record[4], comentario),
          url: buildAppUrl(id, 'view')
        };
      });
    }
  } catch(e) { Logger.log('Push notify error: ' + e.message); }

  return { status:'ok', id:id, result:'rejected' };
}

/* ── GET MY REPORTS (рабочий — все свои отчёты любого статуса, по имени) ── */
// BUG CORREGIDO (seguridad): antes filtraba por el nombre que mandaba el
// propio cliente en la URL — cualquiera podía leer la lista de informes
// de OTRO operario con solo adivinar/conocer su nombre, sin PIN. Ahora se
// exige un PIN válido de rol operario y se usa el nombre que devuelve
// checkUser() (el dueño real del PIN), nunca el parámetro "operario".
function getMyReports(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'operario') return { status:'error', message:'No autorizado' };
  var operario = auth.nombre;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var result = [];

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    // "deleted" (soft-delete, ver deleteRecord) nunca se muestra en las
    // listas normales — es como si no existiera para el operario.
    if (String(r[5]).trim() === operario && r[1] !== 'deleted') {
      var rec = {};
      headers.forEach(function(h, idx){ rec[h] = r[idx]; });
      result.push(rec);
    }
  }
  result.reverse();
  return { status:'ok', data:result };
}

/* ── RESUBMIT (рабочий переотправляет отклонённый отчёт — статус снова pending) ──
 * BUG CORREGIDO (seguridad): no verificaba PIN ni dueño — cualquiera que
 * conociera un ID de informe (PT-0005, correlativos y predecibles) podía
 * reescribir sus datos sin ningún PIN. Ahora exige PIN de rol operario,
 * que el informe sea SUYO, y que esté realmente en 'rejected' (la única
 * transición válida de reenvío — igual que ya exige el frontend). */
function resubmitRecord(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'operario') throw new Error('No autorizado');

  var id = p.id;
  if (!id) throw new Error('No id');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheet.getDataRange().getValues();
  var rowIndex = -1, record = null;

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { rowIndex = i + 1; record = rows[i]; break; }
  }
  if (rowIndex === -1) throw new Error('Record not found: ' + id);
  if (String(record[5]).trim() !== String(auth.nombre).trim()) throw new Error('No autorizado para reenviar este informe');
  // Pedido: el operario puede corregir un informe MIENTRAS sigue pendiente
  // de revisión, no solo después de que lo rechacen — el frontend ahora
  // muestra el botón de editar también en ese estado (ver rdEditBtn en
  // index.html). Un informe ya aprobado sigue sin poder tocarse (es un
  // registro oficial ya copiado a INFORME).
  if (record[1] !== 'rejected' && record[1] !== 'pending') throw new Error('Solo se puede editar un informe pendiente o rechazado');

  var horas  = parseInt(p.horas)    || 0;
  var precio = parseFloat(p.precio) || 0;
  var total  = horas * PRICE_PER_HOUR + precio;

  sheet.getRange(rowIndex, 2).setValue('pending');
  sheet.getRange(rowIndex, 3).setValue(sanitizeCell(p.fecha));
  if (p.cliente)  sheet.getRange(rowIndex, 4).setValue(sanitizeCell(p.cliente));
  if (p.obra)     sheet.getRange(rowIndex, 5).setValue(sanitizeCell(p.obra));
  appendServicioClienteObra(p.cliente, p.obra);
  sheet.getRange(rowIndex, 7).setValue(sanitizeCell(p.ayudante));
  sheet.getRange(rowIndex, 8).setValue(sanitizeCell(p.vehiculo));
  sheet.getRange(rowIndex, 9).setValue(sanitizeCell(p.trabajos));
  sheet.getRange(rowIndex, 11).setValue(sanitizeCell(p.tipo));
  sheet.getRange(rowIndex, 12).setValue(horas);
  sheet.getRange(rowIndex, 13).setValue(sanitizeCell(p.compania));
  sheet.getRange(rowIndex, 14).setValue(sanitizeCell(p.materiales));
  sheet.getRange(rowIndex, 16).setValue(precio);
  sheet.getRange(rowIndex, 17).setValue(total);
  // Pedido: la hora que se muestra junto a la fecha en el detalle del
  // informe (ver fmtTime en index.html) debe reflejar CUÁNDO se formó de
  // verdad — así que un reenvío/edición también actualiza TIMESTAMP, igual
  // que saveReport() lo hace al crearlo por primera vez.
  sheet.getRange(rowIndex, 18).setValue(new Date());
  sheet.getRange(rowIndex, 19).setValue(''); // комментарий очищается при переотправке
  sheet.getRange(rowIndex, 20).setValue('');
  sheet.getRange(rowIndex, 21).setValue('');

  Logger.log('🔄 ' + id + ' reenviado');
  // Telegram desactivado — ver nota en saveReport(). Para reactivar,
  // descomenta la línea siguiente.
  // try { notifyBobNewReport(id, p, horas, precio, total, true); } catch(e) { Logger.log('TG error: ' + e.message); }
  try {
    var cliente = p.cliente || rows[rowIndex-1][3], obra = p.obra || rows[rowIndex-1][4], operario = rows[rowIndex-1][5];
    var mgrPins2 = getPinsWithAccess(cliente, obra);
    var adminPins4 = getAdminPins();
    var allPins4 = mgrPins2.concat(adminPins4).filter(function(v,i,a){ return a.indexOf(v)===i; });
    // Pedido: distinguir "corrigió un informe RECHAZADO" de "actualizó uno
    // que ya seguía pendiente" — antes se mandaba siempre el mismo texto
    // (hablando de "informe rechazado") aunque el informe nunca hubiera
    // sido rechazado, si el operario lo editaba mientras aún estaba
    // pending. record[1] es el estado ANTERIOR a esta misma actualización
    // (se lee más arriba, antes de sheet.getRange(rowIndex,2).setValue(...)).
    var wasRejected = record[1] === 'rejected';
    sendPushLocalized(allPins4, id + '_resubmit_' + Date.now(), function(lang) {
      return {
        title: pushTitle(lang, 'operario', operario || ''),
        body: wasRejected
          ? PUSH_TEXTS[lang].editado_rechazado(id, cliente, obra)
          : PUSH_TEXTS[lang].editado_pending(id, cliente, obra),
        url: buildAppUrl(id, 'view')
      };
    });
  } catch(e) { Logger.log('Push notify error: ' + e.message); }

  return { status:'ok', id:id, result:'resubmitted' };
}

/* ── DELETE (soft-delete): STATUS pasa a "deleted", la fila NUNCA se borra
 * físicamente — conserva el histórico completo y el ID nunca se reutiliza
 * (nextId() usa un contador aparte, independiente del número de filas, así
 * que borrar filas —físicamente o no— jamás afecta la numeración de PT-XXXX
 * de futuros informes). Permisos:
 *   - operario: solo SU PROPIO informe, y solo si NO está aprobado todavía
 *     (pending/rejected) — un informe ya aprobado es un registro oficial
 *     que ya se copió a INFORME, no debe poder borrarlo unilateralmente.
 *   - admin: cualquier informe, en cualquier estado (autoridad total).
 *   - manager: sin permiso de borrado (solo aprueba/rechaza).
 * Tras borrar, se avisa por push a la otra parte interesada: si borra el
 * operario, a los admins; si borra un admin, al operario dueño del informe. */
function deleteRecord(p) {
  var auth = checkUser(p);
  if (!auth.valid) throw new Error('No autorizado');

  var id = p.id;
  if (!id) throw new Error('No id');

  var sheetP = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheetP.getDataRange().getValues();
  var rowIndex = -1, record = null;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { rowIndex = i + 1; record = rows[i]; break; }
  }
  if (rowIndex === -1) throw new Error('Record not found: ' + id);

  // Pedido: ni el operario ni el manager pueden borrar un informe ya
  // APROBADO (es un registro oficial, ya copiado a INFORME) — solo
  // pueden borrar mientras está "en revisión" (pending). El admin
  // mantiene autoridad total, en cualquier estado.
  var isAdmin = auth.rol === 'admin';
  var isOwner = auth.rol === 'operario' && String(record[5]).trim() === String(auth.nombre).trim();
  var isManagerWithAccess = auth.rol === 'manager' && userCanAccess(auth, record[3], record[4]);
  var isPending = record[1] === 'pending';

  if (!isAdmin && !((isOwner || isManagerWithAccess) && isPending)) {
    throw new Error('No autorizado para eliminar este informe');
  }

  sheetP.getRange(rowIndex, 2).setValue('deleted');
  sheetP.getRange(rowIndex, 20).setValue(new Date()); // FECHA_DECISION → fecha de borrado
  sheetP.getRange(rowIndex, 21).setValue(auth.nombre); // MANAGER_NOMBRE → quién lo borró

  Logger.log('🗑 ' + id + ' eliminado por ' + auth.nombre + ' (' + auth.rol + ')');

  try {
    var cliente = record[3], obra = record[4], operarioNombre = record[5];
    var notifyPins = [];
    if (isOwner) {
      // Borró el propio operario → avisamos a los admins
      notifyPins = getAdminPins();
    } else {
      // Borró un admin o un manager → avisamos al operario dueño, y si
      // fue el manager quien borró, también a los admins (para que quede
      // constancia de la decisión ante la autoridad máxima).
      var opPinDel = getPinByNombre(operarioNombre);
      if (opPinDel) notifyPins.push(opPinDel);
      if (isManagerWithAccess) notifyPins = notifyPins.concat(getAdminPins());
    }
    notifyPins = notifyPins.filter(function(v,i,a){ return a.indexOf(v)===i; });
    if (notifyPins.length) {
      sendPushLocalized(notifyPins, id + '_deleted_' + Date.now(), function(lang) {
        return {
          title: pushTitle(lang, auth.rol, auth.nombre || ''),
          body: PUSH_TEXTS[lang].eliminado(id, cliente, obra)
        };
      });
    }
  } catch(e) { Logger.log('Push notify error: ' + e.message); }

  return { status:'ok', id:id, result:'deleted' };
}

/* ── ADMIN STATS: PARTE DE TRABAJO с фильтрами (periodo/cliente/obra/status) ── */
function getAdminStats(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];

  var desde   = p.desde   ? String(p.desde).trim() : '';
  var hasta   = p.hasta   ? String(p.hasta).trim() : '';
  var cliente = p.cliente ? String(p.cliente).trim() : '';
  var obra    = p.obra    ? String(p.obra).trim()    : '';
  var status  = p.status  ? String(p.status).trim()  : '';

  var result = [];
  var totals = { count:0, sum:0, pending:0, approved:0, rejected:0 };

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var rowStatus = r[1], rowCliente = r[3], rowObra = r[4], rowFecha = r[2], rowTotal = parseFloat(r[16]) || 0;

    // "deleted" queda oculto del diario por defecto — el admin puede
    // verlos igualmente si filtra explícitamente por ese estado (misma
    // mecánica de filtro que ya existía para pending/approved/rejected).
    if (!status && rowStatus === 'deleted') continue;
    if (cliente && rowCliente !== cliente) continue;
    if (obra && rowObra !== obra) continue;
    if (status && rowStatus !== status) continue;
    if (desde && dateKey(rowFecha) < desde) continue;
    if (hasta && dateKey(rowFecha) > hasta) continue;

    var rec = {};
    headers.forEach(function(h, idx){ rec[h] = r[idx]; });
    result.push(rec);

    totals.count++;
    totals.sum += rowTotal;
    if (rowStatus === 'pending')  totals.pending++;
    if (rowStatus === 'approved') totals.approved++;
    if (rowStatus === 'rejected') totals.rejected++;
  }

  return { status:'ok', data:result, totals:totals };
}

/* ── GET INFORME: реестр только согласованных (для админ-дашборда, отдельный блок) ── */
function getInforme(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORME);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_INFORME);

  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var result = [];
  var sum = 0;

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var rec = {};
    headers.forEach(function(h, idx){ rec[h] = r[idx]; });
    result.push(rec);
    sum += parseFloat(r[14]) || 0;
  }

  return { status:'ok', data:result, count:result.length, sum:sum };
}

/* ── ANALÍTICA: resumen dinámico por intervalo arbitrario de fechas ──
 * Pedido: pestaña Análisis con trabajadores/materiales/trabajo/total que
 * cambian según el rango de fechas elegido (ya no solo año+mes). Lee
 * INFORME (solo aprobados, el "registro oficial"). precioHora se toma de
 * la columna propia de cada fila (editable a mano en la hoja, ver
 * onEdit() más arriba) con fallback a la constante global PRICE_PER_HOUR
 * para filas aprobadas antes de que existiera esa columna. */
function getAnalyticsSummary(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORME);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_INFORME);
  var rows = sheet.getDataRange().getValues();

  var desde = p.desde ? String(p.desde).trim() : '';
  var hasta = p.hasta ? String(p.hasta).trim() : '';

  var trabajadores = {};
  var materiales = 0, trabajo = 0, total = 0, informes = 0;

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var fKey = dateKey(r[COL.FECHA]);
    if (desde && (!fKey || fKey < desde)) continue;
    if (hasta && (!fKey || fKey > hasta)) continue;

    var operario = String(r[COL.OPERARIO] || '').trim();
    if (operario) trabajadores[operario] = true;
    var precioMat = parseFloat(r[INFORME_COL.PRECIO]) || 0;
    var totalRow = parseFloat(r[INFORME_COL.TOTAL]) || 0;

    // Trabajo (mano de obra) = Total − Materiales, la misma derivación que
    // calcStats() en index.html y que _buildReportPreviewCore ya usan —
    // NUNCA horas×precioHora suelto, porque precioHora puede no coincidir
    // fila a fila (tarifa cambiada a medias, fila cargada a mano sin
    // horas/tarifa reales, etc.) y entonces materiales+trabajo dejan de
    // sumar el TOTAL real de la fila (bug real encontrado 2026-07-28:
    // un objeto de prueba mostraba materiales:0/trabajo:0 pero total:2000).
    materiales += precioMat;
    trabajo += totalRow - precioMat;
    total += totalRow;
    informes++;
  }

  return {
    status: 'ok',
    trabajadores: Object.keys(trabajadores).length,
    materiales: materiales,
    trabajo: trabajo,
    total: total,
    informes: informes // Pedido: sustituye a la plaquita "Total" (redundante con el total de Objetos) por un contador de informes aprobados en el período
  };
}

/* ── ANALÍTICA: desglose por objeto (CLIENTE·OBRA) dentro del mismo intervalo ──
 * Pedido: "un campo donde se muestren los objetos de este mes con
 * cuánto material se compró/cuánto dinero de trabajo/suma, y debajo de
 * todos los puntos la suma total de todos los objetos". */
/* ── ANALÍTICA: detalle al tocar una plaquita de resumen ──
 * Pedido: tocar Trabajadores/Materiales/Trabajo abre de dónde salen esos
 * números. Un único action con "tipo" en vez de 3 endpoints separados —
 * las 3 vistas parten del mismo filtro por fecha sobre INFORME, solo
 * cambia cómo se agrupan/qué campos se devuelven. */
function getAnalyticsDrilldown(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');

  var tipo = String(p.tipo || '').trim();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORME);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_INFORME);
  var rows = sheet.getDataRange().getValues();

  var desde = p.desde ? String(p.desde).trim() : '';
  var hasta = p.hasta ? String(p.hasta).trim() : '';

  var filtered = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var fKey = dateKey(r[COL.FECHA]);
    if (desde && (!fKey || fKey < desde)) continue;
    if (hasta && (!fKey || fKey > hasta)) continue;
    filtered.push(r);
  }

  if (tipo === 'trabajadores') {
    var byOp = {}, order = [];
    filtered.forEach(function(r) {
      var op = String(r[COL.OPERARIO] || '').trim();
      if (!op) return;
      if (!byOp[op]) { byOp[op] = { operario: op, informes: 0, horas: 0, materiales: 0, trabajo: 0, total: 0 }; order.push(op); }
      var horas = parseFloat(r[COL.HORAS]) || 0;
      var precioMat = parseFloat(r[INFORME_COL.PRECIO]) || 0;
      var totalRow = parseFloat(r[INFORME_COL.TOTAL]) || 0;
      byOp[op].informes++;
      byOp[op].horas += horas;
      byOp[op].materiales += precioMat;
      byOp[op].trabajo += totalRow - precioMat; // Total − Materiales, ver nota en getAnalyticsSummary
      byOp[op].total += totalRow;
    });
    return { status: 'ok', tipo: tipo, items: order.map(function(k){ return byOp[k]; }) };
  }

  if (tipo === 'materiales') {
    // "quién compró" — no existe un campo de comprador separado en INFORME,
    // el operario que crea/entrega el informe es quien registra la compra,
    // así que se usa OPERARIO también aquí (pedido explícito: nº de
    // informe/fecha/objeto/comprador/precio).
    var items = filtered.filter(function(r){ return (parseFloat(r[INFORME_COL.PRECIO]) || 0) > 0; }).map(function(r) {
      return {
        id: r[COL.ID], fecha: dateKey(r[COL.FECHA]), compania: String(r[INFORME_COL.COMPANIA] || ''),
        operario: String(r[COL.OPERARIO] || ''),
        precio: parseFloat(r[INFORME_COL.PRECIO]) || 0, cliente: String(r[COL.CLIENTE] || ''), obra: String(r[COL.OBRA] || '')
      };
    });
    return { status: 'ok', tipo: tipo, items: items };
  }

  // 'trabajo' — lista de todos los informes contados en el período. "trabajo"
  // (dinero de mano de obra de esa fila) = Total − Materiales, no el TOTAL
  // completo de la fila (que también incluye materiales) — ver nota en
  // getAnalyticsSummary.
  var items2 = filtered.map(function(r) {
    var precioMat = parseFloat(r[INFORME_COL.PRECIO]) || 0;
    var totalRow = parseFloat(r[INFORME_COL.TOTAL]) || 0;
    return {
      id: r[COL.ID], fecha: dateKey(r[COL.FECHA]), cliente: String(r[COL.CLIENTE] || ''), obra: String(r[COL.OBRA] || ''),
      operario: String(r[COL.OPERARIO] || ''), horas: parseFloat(r[COL.HORAS]) || 0,
      trabajo: totalRow - precioMat, total: totalRow
    };
  });
  return { status: 'ok', tipo: 'trabajo', items: items2 };
}

function getObjectsBreakdown(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORME);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_INFORME);
  var rows = sheet.getDataRange().getValues();

  var desde = p.desde ? String(p.desde).trim() : '';
  var hasta = p.hasta ? String(p.hasta).trim() : '';

  var byObj = {};
  var order = [];
  var grandMateriales = 0, grandTrabajo = 0, grandTotal = 0;

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var fKey = dateKey(r[COL.FECHA]);
    if (desde && (!fKey || fKey < desde)) continue;
    if (hasta && (!fKey || fKey > hasta)) continue;

    var cliente = String(r[COL.CLIENTE] || '').trim();
    var obra = String(r[COL.OBRA] || '').trim();
    var key = cliente + '::' + obra;
    if (!byObj[key]) { byObj[key] = { cliente: cliente, obra: obra, materiales: 0, trabajo: 0, total: 0 }; order.push(key); }

    var precioMat = parseFloat(r[INFORME_COL.PRECIO]) || 0;
    var totalRow = parseFloat(r[INFORME_COL.TOTAL]) || 0;
    var trabajoRow = totalRow - precioMat; // Total − Materiales, ver nota en getAnalyticsSummary

    byObj[key].materiales += precioMat;
    byObj[key].trabajo += trabajoRow;
    byObj[key].total += totalRow;
    grandMateriales += precioMat;
    grandTrabajo += trabajoRow;
    grandTotal += totalRow;
  }

  return {
    status: 'ok',
    objetos: order.map(function(k){ return byObj[k]; }),
    grandTotal: { materiales: grandMateriales, trabajo: grandTrabajo, total: grandTotal }
  };
}

/* ════════ MÓDULO "CREAR INFORME" (PDF/Excel) ════════
 * Agrupa INFORME por OBRA dentro del rango de fechas + objetos elegidos,
 * con naencias/tarifa opcionales SOLO para el informe generado — nunca
 * escribe en INFORME/PARTE, es un cálculo de solo lectura reutilizado
 * tanto para el preview en vivo (buildReportPreview, sin efectos
 * secundarios) como para el archivo final (generateStatReport). "DIAS"
 * = nº de fechas distintas trabajadas en esa obra dentro del rango
 * (no nº de filas), tal y como se ve en la referencia de columnas que
 * mandó el usuario (OBRA|DIAS|HORAS|MATERIALES|TRABAJO). */
function buildReportPreview(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');
  return _buildReportPreviewCore(p);
}

// Extraído para que _generateStatReportCore (llamado también desde el menú
// de la hoja ESTADÍSTICAS, sin PIN) pueda reutilizar el cálculo sin volver
// a exigir checkUser(p) — ver el comentario de _generateStatReportCore.
function _buildReportPreviewCore(p) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORME);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_INFORME);
  var rows = sheet.getDataRange().getValues();

  var desde = p.desde ? String(p.desde).trim() : '';
  var hasta = p.hasta ? String(p.hasta).trim() : '';
  var objetosFiltro = null;
  if (p.objetos) {
    objetosFiltro = {};
    String(p.objetos).split(',').forEach(function(k){ if (k.trim()) objetosFiltro[k.trim()] = true; });
  }
  // Filtros independientes por cliente/obra/operario — pensados para la hoja
  // ESTADÍSTICAS (desplegables sueltos, no pares cliente::obra como el
  // wizard de la app), pero utilizables por cualquier llamador. Ninguno de
  // los callers existentes de la app los envía nunca, así que no cambian
  // ningún comportamiento previo.
  var clienteFiltro = p.cliente ? String(p.cliente).trim() : '';
  var obraFiltro = p.obra ? String(p.obra).trim() : '';
  var operarioFiltro = p.operario ? String(p.operario).trim() : '';
  var pctMateriales = parseFloat(p.pctMateriales) || 0;
  var pctTrabajo = parseFloat(p.pctTrabajo) || 0;
  var rateOverride = (p.precioHoraOverride !== undefined && p.precioHoraOverride !== '' && p.precioHoraOverride !== null) ? parseFloat(p.precioHoraOverride) : null;

  var byObra = {};
  var order = [];
  var informesCount = 0;
  var trabajadoresSet = {};

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var fKey = dateKey(r[COL.FECHA]);
    if (desde && (!fKey || fKey < desde)) continue;
    if (hasta && (!fKey || fKey > hasta)) continue;

    var cliente = String(r[COL.CLIENTE] || '').trim();
    var obra = String(r[COL.OBRA] || '').trim();
    var key = cliente + '::' + obra;
    if (objetosFiltro && !objetosFiltro[key]) continue;
    if (clienteFiltro && cliente !== clienteFiltro) continue;
    if (obraFiltro && obra !== obraFiltro) continue;
    if (operarioFiltro && String(r[COL.OPERARIO] || '').trim() !== operarioFiltro) continue;

    informesCount++;
    var operarioNombre = String(r[COL.OPERARIO] || '').trim();
    if (operarioNombre) trabajadoresSet[operarioNombre] = true;

    if (!byObra[key]) { byObra[key] = { cliente: cliente, obra: obra, dias: {}, horas: 0, materialesOrig: 0, trabajoRawOrig: 0, precioHoraSample: null }; order.push(key); }
    var g = byObra[key];
    if (r[COL.FECHA]) g.dias[String(r[COL.FECHA])] = true;
    var horas = parseFloat(r[COL.HORAS]) || 0;
    var precioMat = parseFloat(r[INFORME_COL.PRECIO]) || 0;
    var precioHora = parseFloat(r[INFORME_COL.PRECIO_HORA]);
    if (isNaN(precioHora)) precioHora = PRICE_PER_HOUR;

    g.horas += horas;
    g.materialesOrig += precioMat;
    // BUG REAL encontrado el 2026-07-27 (continuación), probado con datos
    // sintéticos: la versión anterior sumaba las horas de TODAS las filas
    // del grupo pero multiplicaba por la tarifa de UNA sola fila (la
    // primera, "precioHoraSample") — si la tarifa cambió entre informes de
    // un mismo cliente+obra (p.ej. tras reemplazarTarifaPeriodo() aplicado
    // solo a una parte del período, o una edición manual puntual), el
    // informe exportado infravaloraba (o sobrevaloraba) el trabajo real,
    // sin avisar. Ahora se suma el trabajo REAL de cada fila
    // (TOTAL - materiales, exactamente igual que "Resultados según
    // filtro" en la propia hoja) — así el informe exportado y la página
    // SIEMPRE coinciden para el mismo período/filtros, salvo que el admin
    // pida explícitamente una tarifa hipotética distinta (rateOverride).
    g.trabajoRawOrig += (parseFloat(r[INFORME_COL.TOTAL]) || 0) - precioMat;
    if (g.precioHoraSample === null) g.precioHoraSample = precioHora; // referencia para el "valor original" que muestra el frontend en el tooltip
  }

  var filas = order.map(function(key) {
    var g = byObra[key];
    var materialesFinal = g.materialesOrig * (1 + pctMateriales / 100);
    // Sin override: trabajo real de cada fila, sumado (coincide con la
    // hoja). Con override: sigue siendo la vista previa hipotética "¿y si
    // todas las horas se hubieran pagado a X €/h?" — un cálculo
    // deliberadamente distinto al real, pedido explícitamente por el
    // admin al escribir una tarifa en el wizard.
    var trabajoFinal = (rateOverride !== null && !isNaN(rateOverride))
      ? g.horas * rateOverride * (1 + pctTrabajo / 100)
      : g.trabajoRawOrig * (1 + pctTrabajo / 100);
    return {
      obra: g.obra, cliente: g.cliente,
      dias: Object.keys(g.dias).length,
      horas: g.horas,
      materialesOriginal: g.materialesOrig,
      materiales: materialesFinal,
      precioHoraOriginal: g.precioHoraSample,
      trabajo: trabajoFinal,
      total: materialesFinal + trabajoFinal
    };
  });

  var totales = filas.reduce(function(acc, f) {
    acc.dias += f.dias; acc.horas += f.horas; acc.materiales += f.materiales; acc.trabajo += f.trabajo; acc.total += f.total;
    return acc;
  }, { dias:0, horas:0, materiales:0, trabajo:0, total:0 });
  // Informes/trabajadores del período — no dependen del recargo (son
  // conteos, no dinero), así que se calculan sobre las filas originales,
  // no sobre "filas" (que ya agrupa por objeto y aplica % ahí).
  totales.informes = informesCount;
  totales.trabajadores = Object.keys(trabajadoresSet).length;

  return { status:'ok', filas: filas, totales: totales };
}

// 'yyyy-MM-dd' (formato interno de dateKey/<input type="date">) → 'dd.mm.yyyy'
// (formato pedido para el título del informe generado).
function _fmtDDMMYYYY(isoStr) {
  var parts = String(isoStr || '').split('-');
  if (parts.length !== 3) return String(isoStr || '');
  return parts[2] + '.' + parts[1] + '.' + parts[0];
}

// Carpeta raíz en Drive para los informes generados — se autoconfigura la
// primera vez (mismo espíritu que las Script Properties de OneSignal,
// pero aquí no hace falta que el usuario pegue nada a mano: un ID de
// carpeta no es un secreto, así que se crea sola y se recuerda).
function getOrCreateInformesFolder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INFORMES_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch(e) {} // se borró a mano — recrear abajo
  }
  var folder = DriveApp.createFolder('AEDIS — Informes generados');
  props.setProperty('INFORMES_FOLDER_ID', folder.getId());
  return folder;
}

/* Genera el archivo real (PDF o XLSX) y lo deja en Drive + registrado en
 * INFORMES_GENERADOS. Apps Script no tiene un escritor de Excel nativo,
 * así que el "lienzo" es un Spreadsheet temporal desechable: se rellena
 * con los mismos datos que buildReportPreview(), se exporta vía la URL
 * de exportación de Sheets (funciona para pdf Y xlsx, no hace falta
 * ninguna librería externa), se guarda el blob resultante, y se borra el
 * spreadsheet temporal — no queda basura en el Drive del usuario. */
function generateStatReport(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');
  return _generateStatReportCore(p, auth.nombre);
}

// Extraído de generateStatReport para que un llamador que ya es de
// confianza (el menú de la propia hoja ESTADÍSTICAS, ver
// createReportFromSheetFilters) pueda generar el archivo sin pasar por
// checkUser(p) — que exige un PIN de operario/admin que ese contexto no
// tiene. Misma lógica exacta que antes, solo con el "creadoPor" recibido
// en vez de sacarlo de auth.nombre.
function _generateStatReportCore(p, creadoPor) {
  var formato = String(p.formato || 'pdf').toLowerCase();
  if (formato !== 'pdf' && formato !== 'xlsx') throw new Error('Formato no soportado');

  var preview = _buildReportPreviewCore(p);

  var tempSs = SpreadsheetApp.create('AEDIS_temp_' + new Date().getTime());
  var sh = tempSs.getSheets()[0];
  sh.setName('Informe');

  // Diseño pedido explícitamente: título "RESUMEN <desde> - <hasta>",
  // tabla CLIENTE|OBRA|Materiales|REMUNERACIÓN|Total (ya no OBRA|DIAS|
  // HORAS|...), y debajo un bloque de indicadores (Informes aprobados/
  // Trabajadores distintos/Materiales/Trabajo/TOTAL) — mismo lenguaje
  // visual azul marino que el resto de esta hoja (createEstadisticasSheet).
  var NAVY = '#0b3d91', NAVY_BAND = '#eaf1fb';
  var titulo = 'RESUMEN ' + _fmtDDMMYYYY(p.desde) + ' - ' + _fmtDDMMYYYY(p.hasta);
  sh.getRange(2, 1, 1, 5).merge().setValue(titulo)
    .setFontWeight('bold').setFontSize(14).setFontColor(NAVY).setBackground(NAVY_BAND);

  var headerRow = ['CLIENTE', 'OBRA', 'Materiales', 'REMUNERACIÓN', 'Total'];
  var headerRowIdx = 3;
  sh.getRange(headerRowIdx, 1, 1, headerRow.length).setValues([headerRow])
    .setFontWeight('bold').setBackground(NAVY).setFontColor('#ffffff');

  var dataRows = preview.filas.map(function(f) { return [f.cliente, f.obra, f.materiales, f.trabajo, f.total]; });
  var firstDataRow = headerRowIdx + 1;
  if (dataRows.length) {
    sh.getRange(firstDataRow, 1, dataRows.length, headerRow.length).setValues(dataRows);
    sh.getRange(firstDataRow, 3, dataRows.length, 2).setNumberFormat('#,##0.00 €');
    sh.getRange(firstDataRow, 5, dataRows.length, 1).setFontWeight('bold');
  }
  var lastDataRow = firstDataRow + dataRows.length - 1;

  var separatorRow = lastDataRow + 1;
  sh.getRange(separatorRow, 3, 1, 3).setBorder(true, null, null, null, null, null, NAVY, SpreadsheetApp.BorderStyle.SOLID);

  var informesRow = separatorRow + 1;
  var trabajadoresRow = informesRow + 1;
  var materialesRow = trabajadoresRow + 1;
  var trabajoRow = materialesRow + 1;
  var totalRowIdx = trabajoRow + 1;

  sh.getRange(informesRow, 4).setValue('Informes aprobados').setHorizontalAlignment('right');
  sh.getRange(informesRow, 5).setValue(preview.totales.informes).setHorizontalAlignment('right');
  sh.getRange(trabajadoresRow, 4).setValue('Trabajadores distintos').setHorizontalAlignment('right');
  sh.getRange(trabajadoresRow, 5).setValue(preview.totales.trabajadores).setHorizontalAlignment('right');

  sh.getRange(materialesRow, 4, 1, 2).setBorder(true, null, null, null, null, null, NAVY, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(materialesRow, 4).setValue('Materiales (€)').setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange(materialesRow, 5).setValue(preview.totales.materiales).setFontWeight('bold').setHorizontalAlignment('right').setNumberFormat('#,##0.00 €');
  sh.getRange(trabajoRow, 4).setValue('Trabajo (€)').setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange(trabajoRow, 5).setValue(preview.totales.trabajo).setFontWeight('bold').setHorizontalAlignment('right').setNumberFormat('#,##0.00 €');

  sh.getRange(totalRowIdx, 4).setValue('TOTAL (€)').setFontWeight('bold').setFontSize(16).setFontColor(NAVY).setHorizontalAlignment('right');
  sh.getRange(totalRowIdx, 5).setValue(preview.totales.total).setFontWeight('bold').setFontSize(16).setFontColor(NAVY).setHorizontalAlignment('right').setNumberFormat('#,##0.00 €');

  sh.autoResizeColumns(1, headerRow.length);
  SpreadsheetApp.flush();

  var exportUrl = 'https://docs.google.com/spreadsheets/d/' + tempSs.getId() + '/export?format=' + formato + '&gid=' + sh.getSheetId();
  var response = UrlFetchApp.fetch(exportUrl, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  var mime = formato === 'pdf' ? MimeType.PDF : MimeType.MICROSOFT_EXCEL;
  var ext = formato === 'pdf' ? '.pdf' : '.xlsx';
  var fileName = 'Informe_' + (p.desde || '') + '_a_' + (p.hasta || '') + ext;
  var blob = response.getBlob().setName(fileName).setContentType(mime);

  var folder = getOrCreateInformesFolder();
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  DriveApp.getFileById(tempSs.getId()).setTrashed(true); // el lienzo temporal ya no hace falta

  var id = nextInformeGeneradoId();
  var sheetRG = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORMES_GENERADOS);
  if (!sheetRG) throw new Error('Sheet not found: ' + SHEET_INFORMES_GENERADOS + ' — ejecuta migrateInformesModule() primero');
  sheetRG.appendRow([
    id, new Date(), creadoPor, p.desde || '', p.hasta || '', formato,
    p.objetos || '', pFloatOrZero(p.pctMateriales), pFloatOrZero(p.pctTrabajo), p.precioHoraOverride || '',
    file.getUrl(), 'active'
  ]);

  return { status:'ok', id: id, url: file.getUrl() };
}
function pFloatOrZero(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

function listGeneratedReports(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORMES_GENERADOS);
  if (!sheet) return { status:'ok', reports: [] };
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { status:'ok', reports: [] };
  var headers = rows[0];
  var statusCol = headers.indexOf('STATUS');
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (statusCol > -1 && String(r[statusCol]) === 'deleted') continue;
    var rec = {};
    headers.forEach(function(h, idx){ rec[h] = r[idx]; });
    list.push(rec);
  }
  list.reverse(); // más reciente primero (se añaden al final de la hoja)
  return { status:'ok', reports: list };
}

function deleteGeneratedReport(p) {
  var auth = checkUser(p);
  if (!auth.valid || auth.rol !== 'admin') throw new Error('No autorizado');
  var id = String(p.id || '').trim();
  if (!id) throw new Error('No id');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFORMES_GENERADOS);
  if (!sheet) throw new Error('Sheet not found: ' + SHEET_INFORMES_GENERADOS);
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var idCol = headers.indexOf('ID'), statusCol = headers.indexOf('STATUS');
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idCol]) === id) {
      sheet.getRange(i + 1, statusCol + 1).setValue('deleted'); // soft-delete, mismo criterio que los informes de trabajo
      return { status:'ok' };
    }
  }
  throw new Error('Informe no encontrado');
}

/* ── HISTORIAL PARA MANAGER: últimas 50 entradas approved/rejected de sus objetos ── */
function getHistorial(p) {
  var auth = checkUser(p);
  if (!auth.valid) return { status:'error', message:'Invalid code' };
  if (auth.rol !== 'manager' && auth.rol !== 'admin') return { status:'error', message:'Rol sin acceso' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var result = [];

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var status = r[1], cliente = r[3], obra = r[4];
    if ((status === 'approved' || status === 'rejected') && userCanAccess(auth, cliente, obra)) {
      var rec = {};
      headers.forEach(function(h, idx){ rec[h] = r[idx]; });
      result.push(rec);
    }
  }

  // Сортируем по дате решения (убывание) и берём последние 50
  result.sort(function(a, b) {
    var da = a['FECHA_DECISION'] ? new Date(a['FECHA_DECISION']) : new Date(0);
    var db = b['FECHA_DECISION'] ? new Date(b['FECHA_DECISION']) : new Date(0);
    return db - da;
  });

  return { status:'ok', data: result.slice(0, 50) };
}

/* ── UPLOAD REPORT PHOTOS (production): создаёт папку отчёта с подпапками
 * Obra и Materiales, заливает туда фото, возвращает ссылку на папку отчёта.
 * Структура на Drive: PARTE_PHOTO_FOLDER_ID / {fecha}_{operario}_{id} / Obra / ...
 *                                                                     / Materiales / ...
 */
var PARTE_PHOTO_FOLDER_ID = "1_N8qMgnYMgPLNHqIGTuFOHiIodB2YtNn"; // корневая папка для всех отчётов (aedisapps@gmail.com)

function sanitizeFolderName(s) {
  return String(s || '').replace(/[\\\/:*?"<>|]/g, '_').trim();
}

function getOrCreateSubfolder(parent, name) {
  var existing = parent.getFoldersByName(name);
  if (existing.hasNext()) {
    var f = existing.next();
    // Reforzamos el acceso también en carpetas ya existentes (por si se
    // crearon antes de que esta línea de código existiera, o si alguien
    // cambió manualmente el permiso) — es una llamada barata e idempotente.
    try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {}
    return f;
  }
  var folder = parent.createFolder(name);
  // Открываем доступ ОДИН РАЗ на саму папку — все файлы внутри наследуют его.
  // Это в разы быстрее, чем setSharing на каждый файл отдельно.
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return folder;
}

function uploadPhotosToSubfolder(subfolder, photos, prefix) {
  var links = [];
  if (!photos || !photos.length) return links;
  photos.forEach(function(photo, idx) {
    if (!photo.data || !photo.name) return;
    var base64 = photo.data.indexOf('base64,') !== -1
      ? photo.data.split('base64,')[1]
      : photo.data;
    var mimeType = photo.type || 'image/jpeg';
    var blob = Utilities.newBlob(
      Utilities.base64Decode(base64), mimeType,
      prefix + '_' + (idx + 1) + '_' + photo.name
    );
    var file = subfolder.createFile(blob);
    // setSharing на каждый файл убран — это самый медленный вызов API (отдельный
    // запрос на файл). Вместо этого права открываются ОДИН РАЗ на саму папку
    // (см. getOrCreateSubfolder ниже) — файлы внутри открытой папки доступны
    // по той же ссылке без необходимости делиться каждым отдельно.
    // Формат thumbnail-ссылки — встраивается напрямую как <img src>, без перехода на Drive.
    links.push('https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w2000');
  });
  return links;
}

/* photosObra, photosMateriales — массивы [{name, type, data(base64)}].
 * Возвращает { status, folderUrl, obraCount, materialesCount } */
// Извлекает el ID de una carpeta a partir de su URL de Google Drive
function extractFolderIdFromUrl(url) {
  var m = String(url || '').match(/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Dado un enlace de carpeta de Drive (tal como está guardado en la hoja,
// sin modificar su formato), devuelve las fotos individuales dentro de ella
// como enlaces thumbnail listos para mostrar en la galería de la app.
// BUG CORREGIDO (seguridad): no pedía PIN y aceptaba CUALQUIER URL de
// carpeta de Drive — como el script corre "Execute as: Me", en teoría
// podía listar cualquier carpeta a la que esa cuenta tenga acceso, no
// solo carpetas de informes. Ahora exige PIN y verifica que la carpeta
// pedida está realmente enlazada a un informe al que ese usuario tiene
// derecho de acceso (dueño, manager con acceso al cliente:obra, o admin).
function getFolderPhotos(p) {
  var auth = checkUser(p);
  if (!auth.valid) return { status:'error', message:'No autorizado' };

  var folderUrl = p.url || '';
  var folderId = extractFolderIdFromUrl(folderUrl);
  if (!folderId) return { status:'error', message:'URL de carpeta inválida' };

  var sheet2 = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows2 = sheet2.getDataRange().getValues();
  var allowed = false;
  for (var j = 1; j < rows2.length; j++) {
    var r2 = rows2[j];
    if (String(r2[9]).indexOf(folderId) === -1 && String(r2[14]).indexOf(folderId) === -1) continue;
    if (auth.rol === 'admin' ||
        (auth.rol === 'operario' && String(r2[5]).trim() === auth.nombre) ||
        (auth.rol === 'manager' && userCanAccess(auth, r2[3], r2[4]))) { allowed = true; break; }
  }
  if (!allowed) return { status:'error', message:'No autorizado para esta carpeta' };

  try {
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFiles();
    var photos = [];
    while (files.hasNext()) {
      var file = files.next();
      var mime = file.getMimeType() || '';
      if (mime.indexOf('image/') === 0) {
        photos.push('https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w2000');
      }
    }
    return { status:'ok', photos:photos };
  } catch(err) {
    return { status:'error', message:'No se pudo leer la carpeta: ' + err.message };
  }
}

// Saca el fileId de una URL de miniatura tal como las genera getFolderPhotos
// de arriba: "https://drive.google.com/thumbnail?id=XXXX&sz=w...".
function extractFileIdFromThumbnailUrl(url) {
  var m = String(url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Pedido: en el editor de informe, una foto YA subida (no solo las nuevas
// de esta sesión) también debe poder borrarse, no solo añadirse más.
// Mismas reglas de autorización que uploadReportPhotos: dueño del informe,
// manager con acceso a ese cliente:obra, o admin — y nunca sobre un
// informe ya aprobado (registro oficial cerrado).
function deleteReportPhoto(p) {
  var auth = checkUser(p);
  if (!auth.valid) return { status:'error', message:'No autorizado' };

  var id = p.id;
  var fileId = extractFileIdFromThumbnailUrl(p.fileUrl);
  if (!id || !fileId) return { status:'error', message:'Datos incompletos' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheet.getDataRange().getValues();
  var record = null;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { record = rows[i]; break; }
  }
  if (!record) return { status:'error', message:'Informe no encontrado' };

  var isOwner = auth.rol === 'operario' && String(record[5]).trim() === auth.nombre;
  var hasAccess = (auth.rol === 'admin') ||
                  (auth.rol === 'manager' && userCanAccess(auth, record[3], record[4])) ||
                  isOwner;
  if (!hasAccess) return { status:'error', message:'No autorizado para este informe' };
  if (record[1] === 'approved') return { status:'error', message:'No se puede modificar un informe ya aprobado' };

  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    return { status:'ok' };
  } catch(err) {
    return { status:'error', message:'No se pudo borrar la foto: ' + err.message };
  }
}

// BUG CORREGIDO (seguridad): esta función no verificaba PIN en absoluto —
// cualquiera que conociera un ID de informe (PT-0005, correlativos y
// predecibles) podía adjuntar fotos a un informe ajeno, incluso ya
// aprobado. Ahora exige PIN válido y que el llamante tenga derecho sobre
// ESE informe concreto: el propio operario dueño, un manager con acceso
// a ese cliente:obra, o un admin.
function uploadReportPhotos(p) {
  var auth = checkUser(p);
  if (!auth.valid) return { status:'error', message:'No autorizado' };

  var id = p.id;
  var fecha = p.fecha || '';
  if (!id) return { status:'error', message:'No id' };

  // Сначала проверяем, что такой ID реально существует в PARTE DE TRABAJO —
  // иначе фото загрузятся на Drive, но ссылка никуда не запишется.
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PARTE);
  var rows = sheet.getDataRange().getValues();
  var rowIndex = -1, record = null;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { rowIndex = i + 1; record = rows[i]; break; }
  }
  if (rowIndex === -1) {
    return { status:'error', message:'No existe ningún informe con ID "' + id + '" en PARTE DE TRABAJO. Verifique el ID exacto de la fila.' };
  }

  var isOwner = auth.rol === 'operario' && String(record[5]).trim() === auth.nombre;
  var hasAccess = (auth.rol === 'admin') ||
                  (auth.rol === 'manager' && userCanAccess(auth, record[3], record[4])) ||
                  isOwner;
  if (!hasAccess) return { status:'error', message:'No autorizado para este informe' };

  // El nombre de carpeta SIEMPRE sale del propio registro (dueño real del
  // informe), nunca del parámetro que manda el cliente — evita que alguien
  // con acceso (manager/admin) subiendo fotos a un informe ajeno cree una
  // carpeta con nombre falso.
  var operario = sanitizeFolderName(record[5] || 'SIN_NOMBRE');

  try {
    var rootFolder = DriveApp.getFolderById(PARTE_PHOTO_FOLDER_ID);
    var reportFolderName = sanitizeFolderName(fecha) + '_' + operario + '_' + id;
    var reportFolder = getOrCreateSubfolder(rootFolder, reportFolderName);

    var obraLinks = [];
    var materialesLinks = [];
    var obraFolderUrl = '';
    var materialesFolderUrl = '';

    if (p.photosObra && p.photosObra.length) {
      var obraFolder = getOrCreateSubfolder(reportFolder, 'Obra');
      obraLinks = uploadPhotosToSubfolder(obraFolder, p.photosObra, 'obra');
      obraFolderUrl = obraFolder.getUrl();
    }
    if (p.photosMateriales && p.photosMateriales.length) {
      var materialesFolder = getOrCreateSubfolder(reportFolder, 'Materiales');
      materialesLinks = uploadPhotosToSubfolder(materialesFolder, p.photosMateriales, 'mat');
      materialesFolderUrl = materialesFolder.getUrl();
    }

    // Записываем ссылку на КАЖДУЮ подпапку в свою колонку — только если фото
    // этой группы реально были загружены (иначе не затираем уже существующую ссылку)
    if (obraFolderUrl)       sheet.getRange(rowIndex, 10).setValue(obraFolderUrl); // FOTOS DE OBRA
    if (materialesFolderUrl) sheet.getRange(rowIndex, 15).setValue(materialesFolderUrl); // FOTO MATERIALES / RECIBO

    return {
      status: 'ok',
      reportFolderUrl: reportFolder.getUrl(),
      obraFolderUrl: obraFolderUrl,
      materialesFolderUrl: materialesFolderUrl,
      obraCount: obraLinks.length,
      materialesCount: materialesLinks.length
    };

  } catch(err) {
    return { status:'error', message: 'Excepción durante la subida: ' + err.message, stack: err.stack || '' };
  }
}

/* ── ТЕСТ ЗАГРУЗКИ ФОТО НА DRIVE (диагностика проблемы "приходит только имя файла") ──
 * Перед использованием: создайте папку на Google Drive для тестовых фото,
 * скопируйте её ID из URL (часть после /folders/) и вставьте ниже.
 */
var TEST_PHOTO_FOLDER_ID = "1DOAM2liqmGjxzRJkLpzQFipqy_4NnIrU"; // PARTE TEST FOTOS

function testGrantDriveAccess() {
  // Эта функция нужна только чтобы Google показал окно запроса прав на Drive
  // при ручном запуске в редакторе. Запустите её один раз через ▶ Выполнить.
  // Важно: запрашиваем не только чтение папки, но и право СОЗДАВАТЬ файлы —
  // это отдельное разрешение (drive.file / drive), не совпадающее с readonly.
  var folder = DriveApp.getFolderById(TEST_PHOTO_FOLDER_ID);
  Logger.log('✅ Доступ на чтение папки подтверждён: ' + folder.getName());

  var testBlob = Utilities.newBlob('test', 'text/plain', '_permission_test.txt');
  var testFile = folder.createFile(testBlob);
  Logger.log('✅ Доступ на запись подтверждён, тестовый файл создан: ' + testFile.getUrl());

  testFile.setTrashed(true); // сразу удаляем тестовый файл, он был нужен только для проверки прав
  Logger.log('🗑 Тестовый файл удалён, проверка завершена успешно');
}

function testPhotoUploadHandler(p) {
  var photos = p.photos;
  if (!photos || !photos.length) {
    return { status:'error', message:'No photos received — payload.photos is empty or missing' };
  }

  var diagnostics = [];
  photos.forEach(function(photo, idx) {
    diagnostics.push({
      index: idx,
      name: photo.name || '(нет имени)',
      type: photo.type || '(нет типа)',
      dataLength: photo.data ? photo.data.length : 0,
      dataPreview: photo.data ? photo.data.substring(0, 60) : '(данных нет!)',
      hasBase64Marker: photo.data ? photo.data.indexOf('base64,') !== -1 : false
    });
  });

  try {
    var folder = DriveApp.getFolderById(TEST_PHOTO_FOLDER_ID);
    var links = [];

    photos.forEach(function(photo, idx) {
      if (!photo.data || !photo.name) return;
      var base64 = photo.data.indexOf('base64,') !== -1
        ? photo.data.split('base64,')[1]
        : photo.data;
      var mimeType = photo.type || 'image/jpeg';
      var blob = Utilities.newBlob(
        Utilities.base64Decode(base64), mimeType,
        'test_' + (idx + 1) + '_' + photo.name
      );
      var file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      links.push(file.getUrl());
    });

    return { status:'ok', links:links, diagnostics:diagnostics };

  } catch(err) {
    return {
      status: 'error',
      message: 'Excepción durante la subida: ' + err.message,
      stack: err.stack || '(sin stack)',
      diagnostics: diagnostics
    };
  }
}


function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function tgSend(chatId, text) {
  if (!chatId) return;
  var url = 'https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage';
  var payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  var response = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var rj = JSON.parse(response.getContentText());
  if (!rj.ok) Logger.log('❌ TG error: ' + rj.description);
}

function notifyBobNewReport(id, d, horas, precio, total, isResubmit) {
  var lines = [];
  lines.push(isResubmit ? '<b>🔄 ОТЧЁТ ПЕРЕОТПРАВЛЕН</b>' : '<b>📋 НОВЫЙ ОТЧЁТ НА СОГЛАСОВАНИЕ</b>');
  lines.push('');
  lines.push('🆔 <b>№:</b> ' + esc(id));
  if (d.cliente)  lines.push('🏢 <b>Cliente:</b> ' + esc(d.cliente));
  if (d.obra)     lines.push('📍 <b>Obra:</b> ' + esc(d.obra));
  if (d.operario) lines.push('👤 <b>Operario:</b> ' + esc(d.operario));
  if (horas)      lines.push('⏱ <b>Horas:</b> ' + horas + ' h');
  if (total)      lines.push('💶 <b>Total:</b> ' + total + ' €');
  lines.push('');
  lines.push('⏳ Ожидает согласования менеджера');
  tgSend(TG_CHAT_BOB, lines.join('\n'));
}

function notifyBobDecision(id, record, decision, managerName, comentario) {
  var lines = [];
  lines.push(decision === 'approved' ? '<b>✅ ОТЧЁТ СОГЛАСОВАН</b>' : '<b>❌ ОТЧЁТ ОТКЛОНЁН</b>');
  lines.push('');
  lines.push('🆔 <b>№:</b> ' + esc(id));
  lines.push('🏢 <b>Cliente:</b> ' + esc(record[3]));
  lines.push('📍 <b>Obra:</b> ' + esc(record[4]));
  lines.push('👤 <b>Operario:</b> ' + esc(record[5]));
  lines.push('👔 <b>Менеджер:</b> ' + esc(managerName));
  if (decision === 'rejected' && comentario) {
    lines.push('');
    lines.push('💬 <b>Комментарий:</b> ' + esc(comentario));
  }
  tgSend(TG_CHAT_BOB, lines.join('\n'));
}

function notifyOperario(operarioName, id, decision, comentario) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_OPERARIOS_TG);
  if (!sheet) { Logger.log('OPERARIOS_TG sheet not found, skip personal notify'); return; }

  var rows = sheet.getDataRange().getValues();
  var chatId = null;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(operarioName).trim()) { chatId = rows[i][1]; break; }
  }
  if (!chatId) { Logger.log('No chat_id for operario: ' + operarioName); return; }

  var lines = [];
  if (decision === 'approved') {
    lines.push('<b>✅ Tu informe ' + esc(id) + ' fue aprobado</b>');
  } else {
    lines.push('<b>❌ Tu informe ' + esc(id) + ' fue rechazado</b>');
    if (comentario) lines.push('💬 ' + esc(comentario));
    lines.push('');
    lines.push('Abre la app y revisa "Mis informes" para corregir y reenviar.');
  }
  tgSend(chatId, lines.join('\n'));
}

/* ── Crecimiento automático de las listas Cliente/Obra ──
 * Pedido: cuando un operario da de alta un cliente u objeto nuevo (modo
 * "Nueva" del formulario, en vez de elegirlo de la Lista), ese valor debe
 * quedar disponible como opción para el futuro sin que nadie lo añada a
 * mano en la hoja. CLIENTE y OBRA son dos columnas independientes (no
 * pares fijos por fila — ver el comentario de userCanAccess), así que cada
 * una crece por separado: se escribe en el primer hueco vacío de SU PROPIA
 * columna, no necesariamente en la misma fila que la otra. */
function appendServicioValue(colIndex, value) {
  value = String(value || '').trim();
  if (!value) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SERVICIO);
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return;
  var col = sheet.getRange(1, colIndex + 1, lastRow, 1).getValues();
  for (var i = 1; i < col.length; i++) {
    if (String(col[i][0] || '').trim().toLowerCase() === value.toLowerCase()) return; // ya existe
  }
  var targetRow = col.length + 1;
  for (var j = 1; j < col.length; j++) {
    if (!String(col[j][0] || '').trim()) { targetRow = j + 1; break; }
  }
  sheet.getRange(targetRow, colIndex + 1).setValue(value);
}
function appendServicioClienteObra(cliente, obra) {
  try {
    appendServicioValue(0, cliente); // columna A — CLIENTE
    appendServicioValue(1, obra);    // columna B — OBRA
  } catch(e) { Logger.log('appendServicioClienteObra error: ' + e.message); }
}

/* ── LISTS (для формы рабочего) ── */
function getListsData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SERVICIO);
  if (!sheet) throw new Error("Sheet 'servicio' not found");
  var rows = sheet.getDataRange().getValues();
  var cl=[],ob=[],op=[],ti=[],co=[];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    pu(cl,r[0]); pu(ob,r[1]); pu(op,r[2]); pu(op,r[3]); pu(ti,r[4]); pu(co,r[5]);
  }
  return { status:'ok', data:{ clientes:cl, obras:ob, operarios:op, tipos:ti, companias:co } };
}

// Evita que un texto que empieza por =, +, -, @ se interprete como
// fórmula al escribirlo en Sheets (formula injection) — antepone un
// apóstrofo, que Sheets trata como "forzar texto plano".
function sanitizeCell(s) {
  s = String(s == null ? '' : s);
  return /^[=+\-@]/.test(s) ? ("'" + s) : s;
}

// Bug real encontrado (afecta getAdminStats/getAnalyticsSummary/
// getObjectsBreakdown/buildReportPreview): comparar objetos Date
// directamente para un filtro desde/hasta es una trampa de huso
// horario. Una celda FECHA se lee como medianoche LOCAL de la hoja
// (según el huso configurado en Archivo → Configuración de la hoja),
// pero `new Date('2026-07-01')` en el backend siempre parsea como
// medianoche UTC — si el huso de la hoja no es UTC, restar/comparar
// esos dos objetos Date puede excluir en silencio filas justo del
// primer o último día del rango (exactamente el síntoma reportado:
// "no sincroniza con todos los informes" / totales que no cuadran).
// Arreglo: comparar por CALENDARIO — convertir la fecha de la fila a
// 'yyyy-MM-dd' en el huso de la propia hoja, y compararla como string
// contra desde/hasta (que ya llegan en ese mismo formato desde
// <input type="date"> del frontend) — evita toda la ambigüedad de
// husos horarios de raíz, no hace falta reinterpretarla en ningún sitio.
function dateKey(val) {
  if (!val) return '';
  var d = (val instanceof Date) ? val : new Date(val);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

function pu(arr, val) {
  if (!val) return;
  var v = String(val).trim();
  if (v && arr.indexOf(v) === -1) arr.push(v);
}

/* ── ТЕСТЫ (запускать вручную из редактора Apps Script) ── */
function test0_TelegramPing() {
  tgSend(TG_CHAT_BOB, '🔔 Test de conexión OK — proyecto PARTE TEST v3 (PARTE DE TRABAJO + INFORME)');
}

function test1_CheckUser_Operario() {
  Logger.log(JSON.stringify(checkUser({ codigo:'1111' })));
}

function test2_CheckUser_Manager() {
  Logger.log(JSON.stringify(checkUser({ codigo:'3333' })));
}

function test3_CheckUser_Admin() {
  Logger.log(JSON.stringify(checkUser({ codigo:'9999' })));
}

function test4_SaveReport() {
  var result = saveReport({
    fecha:'2026-06-30', cliente:'CASA FUSTER', obra:'ORIGINAL',
    operario:'MOHA', ayudante:'ABDEL', vehiculo:'1234-ABC',
    trabajos:'Test v3 — entra directo en PARTE DE TRABAJO', tipo:'Construcción / Строительные работы',
    horas:6, compania:'OBRAMAT', materiales:'Cemento, arena', precio:120
  });
  Logger.log('RESULT: ' + JSON.stringify(result));
}

function test5_GetPendingForManager() {
  var result = getPendingForUser({ codigo:'3333' });
  Logger.log('RESULT: ' + JSON.stringify(result));
}

function test6_GetPendingForAdmin() {
  var result = getPendingForUser({ codigo:'9999' });
  Logger.log('RESULT: ' + JSON.stringify(result));
}

function test7_Approve() {
  // подставьте реальный ID из PARTE DE TRABAJO (например 'PT-0001')
  var result = approveRecord({ codigo:'3333', id:'PT-0001' });
  Logger.log('RESULT: ' + JSON.stringify(result));
}

function test8_Reject() {
  var result = rejectRecord({ codigo:'3333', id:'PT-0002', comentario:'Falta indicar el número de horas extra' });
  Logger.log('RESULT: ' + JSON.stringify(result));
}

function test9_AdminStats() {
  var result = getAdminStats({ codigo:'9999' });
  Logger.log('RESULT: ' + JSON.stringify(result));
}

function test10_GetInforme() {
  var result = getInforme({ codigo:'9999' });
  Logger.log('RESULT: ' + JSON.stringify(result));
}
