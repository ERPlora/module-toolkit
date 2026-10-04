# WORKFLOW — WhatsApp

Prefijo: WHATSAPP_INBOX
Alcance MVP: transversal

## Para qué sirve y para quién
La bandeja de WhatsApp del negocio: el responsable atiende las conversaciones y las clientas piden cita.

## Referencia adoptada
La plataforma de WhatsApp Business de Meta y la bandeja de Fresha.

## Antes de empezar
El número de WhatsApp del negocio conectado.

## Pantallas

### Conversaciones
Se llega desde el menú «WhatsApp». Vacía: «Sin conversaciones». Cargando: esqueleto. Con error: aviso y «Reintentar».

## Flujos
| Flujo | Fichero |
|---|---|
| WHATSAPP_INBOX-F01 Pedir una cita por WhatsApp | workflow/conversaciones.md |
| WHATSAPP_INBOX-F02 Responder fuera del horario de atención | workflow/conversaciones.md |

## Cobertura contra la referencia
| Elemento | Estado | Flujo |
|---|---|---|
| Reserva conversacional | parcial | WHATSAPP_INBOX-F01 |
| Respuesta automática fuera de horario | no hecho | WHATSAPP_INBOX-F02 |

## Datos: de quién es cada dato
Los mensajes son de este componente; la clienta se lee de clientes. Dato personal: el teléfono y los mensajes.

## Reglas que no se rompen
Una conversación solo se ve en su hub.

## Lo que NO hace, a propósito
No envía publicidad.

## Dudas abiertas
Ninguna.
