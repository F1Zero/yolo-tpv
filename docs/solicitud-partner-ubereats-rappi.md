# Solicitud de integración API (Partner) — YOLO Coffee Shop
Para conectar **YOLO TPV** con **Uber Eats** y **Rappi** y recibir los pedidos automáticamente (con su folio).

---

## Requisito 0 (importante)
La API **conecta una tienda que YA existe** en la plataforma. Antes de pedir API, YOLO debe estar **activo como restaurante**:
- **Uber Eats:** dado de alta y vendiendo en Uber Eats Manager.
- **Rappi:** dado de alta y vendiendo en Rappi Partners (Aliados).

Si ya venden en ambas, seguimos. Si en alguna no, primero hay que darse de alta como restaurante (eso es el proceso comercial normal, no el de API).

## Datos que te van a pedir (tenlos a la mano)
- Razón social: **YOLO COFFEE SHOP** · RFC: **YCS230608N64**
- Dirección: Calle 6 Av. José Vasconcelos #280 por 17B y 19, Col. Jardines de Vista Alegre, C.P. 97138, Mérida
- Tel: 9999438625 · Email: yoloyucatan@gmail.com
- **Store ID / ID de tienda** en cada plataforma (viene en tu panel de Uber Eats Manager / Rappi Partners)
- Contacto técnico: **Fernando E. Balmes Moguel** (fbalmes2@gmail.com)
- Sistema POS: **"POS propio — YOLO TPV (desarrollo propio, web/PWA)"**
- **URL del webhook** (a dónde te envían los pedidos): te la preparo yo cuando tengas las credenciales (será tu Apps Script).

---

## UBER EATS
1. Entra a **https://developer.uber.com/** con la cuenta de Uber Eats del negocio.
2. Crea una **app** (empieza en modo *sandbox* para pruebas).
3. En la sección **Eats → Getting Started**, solicita acceso a las **Marketplace / POS APIs**.
4. Uber pide: **firmar NDA + acuerdo de licencia de API** y **hablar con tu Uber Eats partner manager** (gerente de cuenta).
5. Al aprobarte te dan **client_id / client_secret** (OAuth 2.0), con el scope `eats.pos_provisioning`.
- Docs: https://developer.uber.com/docs/eats/guides/getting-started
- Si no tienes gerente de cuenta, pídelo desde Uber Eats Manager (Ayuda/Soporte → integración con POS).

## RAPPI
1. Entra a **https://dev-portal.rappi.com/** (Partners / Developer Portal).
2. Solicita el **onboarding manual** para que te entreguen **client_id / client_secret**.
3. Tendrás que pasar la **certificación del equipo de Integraciones** de Rappi para pasar a producción (hay reglas: mínimo 45 s entre peticiones, 98% de éxito).
- Docs: https://dev-portal.rappi.com/es/authentication-process/  y  https://dev-portal.rappi.com/es/rests-api/
- Contacto: tu ejecutivo de **Rappi Partners** / soporte de aliados.

---

## Borrador de correo / mensaje (sirve para ambas)
> **Asunto:** Solicitud de integración por API (POS propio) — YOLO Coffee Shop
>
> Hola, buen día.
>
> Somos **YOLO Coffee Shop** (razón social YOLO COFFEE SHOP, RFC YCS230608N64), restaurante activo en su plataforma en Mérida, Yucatán.
>
> Queremos **integrar nuestro sistema de punto de venta propio (YOLO TPV)** con su API para **recibir los pedidos automáticamente** y darles seguimiento desde nuestro sistema (aceptación, folio, estatus).
>
> ¿Podrían indicarnos el proceso para obtener acceso a la **API de integración/POS** (credenciales OAuth y documentación), y con quién continúo el trámite (NDA/acuerdo y certificación)?
>
> Datos de la tienda:
> - Nombre/ID de tienda: **(pon aquí tu Store ID)**
> - Dirección: Calle 6 Av. José Vasconcelos #280, Col. Jardines de Vista Alegre, C.P. 97138, Mérida
> - Contacto técnico: Fernando E. Balmes Moguel — fbalmes2@gmail.com — 9999438625
> - POS: desarrollo propio (web/PWA), listo para recibir *webhooks* de pedidos.
>
> Quedamos atentos. Gracias.
> **Fernando E. Balmes Moguel — YOLO Coffee Shop**

---

## Después de que te aprueben
Cuando tengas **client_id / client_secret** de cada una, yo monto:
- El **webhook** (buzón que recibe el pedido) en tu Apps Script → cae en el Google Sheet.
- La **asignación automática de folio** y que el pedido aparezca en YOLO TPV como una nota.
- Aceptar/actualizar estatus del pedido hacia la plataforma.

> ⚠️ Las credenciales (client_secret) van **solo del lado del Apps Script (privado)**, nunca en el repositorio público.
