# WORKFLOW — Citas

Prefijo: APPOINTMENTS
Alcance MVP: peluqueria

## Para qué sirve y para quién
La agenda del salón: el responsable y los empleados ven y dan las citas de las clientas.

## Referencia adoptada
Fresha y Square Appointments: agenda por profesional; una cita es clienta, servicio, profesional y hora.

## Antes de empezar
Tiene que haber al menos un servicio y un profesional con horario.

~~~
### APPOINTMENTS-F99 Esto no es un flujo: está dentro de un bloque de código
Prefijo: OTRO
Estado: inventado
~~~

## Pantallas

### Agenda
Se llega desde el menú «Agenda». Vacía: «No hay citas hoy». Cargando: esqueleto. Con error: aviso y «Reintentar».

## Flujos

### APPOINTMENTS-F01 Dar una cita desde la agenda
Estado: hecho
Actor: responsable, empleado
Pantalla: Agenda
Pasos:
1. Pulsa un hueco libre de la agenda.
2. Elige la clienta, el servicio y el profesional.
3. Pulsa «Guardar».
4. La cita aparece en el hueco con el nombre de la clienta.
Entra: el servicio (servicios) y la clienta (clientes).
Sale: la cita guardada; la conversación de WhatsApp de la clienta la muestra.
Si falla: si el hueco ya está ocupado, se ve el aviso y se elige otro.
Implicados: WHATSAPP_INBOX-F01
QA: B-02, W-01

### APPOINTMENTS-F02 [retirado] Aceptar solicitudes desde la pestaña Solicitudes
Implicados: ninguno

## Cobertura contra la referencia
| Elemento | Estado | Flujo |
|---|---|---|
| Cita con clienta, servicio, profesional y hora | hecho | APPOINTMENTS-F01 |

## Datos: de quién es cada dato
La cita es de este componente; la clienta se lee de clientes. Dato personal: el nombre de la clienta en la cita.

## Reglas que no se rompen
Una cita solo se ve en su hub.

## Lo que NO hace, a propósito
No cobra: el cobro es de ventas.

## Dudas abiertas
Ninguna.

## Fuentes contrastadas
El manual dice que la cita se puede arrastrar a otro día; el código solo deja moverla dentro del mismo día.
