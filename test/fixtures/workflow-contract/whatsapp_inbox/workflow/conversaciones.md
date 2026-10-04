# WORKFLOW — WhatsApp · Conversaciones

Prefijo: WHATSAPP_INBOX

## Flujos

### WHATSAPP_INBOX-F01 Pedir una cita por WhatsApp
Estado: parcial — falta ofrecer otro hueco cuando el pedido está ocupado
Vertical: peluqueria
Actor: cliente
Pantalla: Conversaciones
Pasos:
1. La clienta escribe al número del negocio.
2. Elige servicio y hora entre los que se le ofrecen.
3. Confirma.
4. Recibe la confirmación y el responsable ve la cita en la agenda.
Entra: los huecos libres (citas).
Sale: una cita nueva en la agenda (citas) y el mensaje de confirmación.
Si falla: la clienta recibe «No hemos podido reservar» y la conversación queda para el responsable.
Implicados: APPOINTMENTS-F01
Pendiente de enlazar: customers — reconocer a la clienta por su teléfono
QA: WA-01

### WHATSAPP_INBOX-F02 Responder fuera del horario de atención
Estado: no hecho — falta la respuesta automática fuera de horario
Vertical: comun
Actor: sistema
Pantalla: ninguna
Pasos:
1. La clienta escribe fuera del horario del negocio.
2. Recibe al momento un mensaje con el horario de atención.
Entra: el horario del negocio (horarios).
Sale: el mensaje automático en la conversación.
Si falla: la conversación queda sin respuesta automática y la atiende el responsable, como cualquier otra.
Implicados: pendiente
Pendiente de enlazar: schedules — el horario de apertura del negocio
QA: qa-hub-restaurant §05
