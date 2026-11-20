# Mis Finanzas

Aplicación web para registrar ingresos y gastos. Node.js + SQLite, **sin dependencias** (no hay `npm install`).

## Probar en local
Requiere Node 22.13 o superior.

    node server.js
    # abre http://localhost:3000

Los datos se guardan en `data/finanzas.db`.

## API
| Método | Ruta | Descripción |
|---|---|---|
| POST | /api/register | Crear cuenta `{email, password}` |
| POST | /api/login | Iniciar sesión |
| POST | /api/logout | Cerrar sesión |
| GET | /api/records | Consultar todos los registros |
| GET | /api/records/:id | Consultar un registro |
| POST | /api/records | Agregar |
| PUT | /api/records/:id | Editar |
| DELETE | /api/records/:id | Eliminar |
| GET | /healthz | Verificación de salud (Render) |

## Desplegar en Render
1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: **New > Blueprint** y elige el repositorio (usa `render.yaml`).
   O bien **New > Web Service** con: Runtime `Node`, Build Command `echo ok`,
   Start Command `node server.js`, y la variable `NODE_VERSION=22.16.0`.
3. Cuando termine, abre la URL `https://mis-finanzas-xxxx.onrender.com`.

### Importante sobre los datos
En el plan gratuito el disco de Render es **temporal**: la base de datos SQLite se
reinicia en cada nuevo despliegue o reinicio del servicio. Sirve para pruebas.
Para conservar los datos agrega un **Disk** (plan de pago) montado en `/var/data`
y define `DB_PATH=/var/data/finanzas.db`.
