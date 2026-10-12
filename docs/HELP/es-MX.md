# Ayuda de bonis oculis

bonis oculis revisa una película una vez, aquí en esta computadora, y anota dónde están las escenas que no quieres ver. Cuando alguien le da Ver, esas escenas se omiten. No se envía nada a ningún lado.

## Abrir la app por primera vez {#start}

Esta primera versión de bonis oculis todavía no está firmada por Apple ni por Microsoft, así que tu computadora pregunta antes de abrirla la primera vez. Solo pasa una vez.

**En una Mac**

1. Abre la carpeta Aplicaciones y busca bonis oculis.
2. Mantén presionada la tecla Control y haz clic en la app (o haz clic derecho), y elige **Abrir**.
3. En el mensaje que aparece, elige **Abrir** otra vez.

Desde entonces se abre normalmente.

**En Windows**

1. Haz doble clic en el instalador o en la app.
2. Si una ventana azul dice "Windows protegió tu PC", haz clic en **Más información**.
3. Haz clic en **Ejecutar de todas formas**.

> bonis oculis nunca se conecta a internet, así que no pasa nada si tu firewall la bloquea.

## Cómo funciona el análisis {#scanning}

Cuando agregas una película, bonis oculis la revisa una vez y hace una lista de las escenas que hay que omitir. Lee los subtítulos y mira la imagen, uno o dos cuadros por segundo. La película nunca se modifica.

- **Cuánto tarda.** En una laptop común, una película de dos horas tarda de 30 a 60 minutos si tiene subtítulos, y más si no los tiene. Una computadora más nueva es más rápida.
- **Trabaja en segundo plano.** Puedes seguir usando la app. El análisis tiene baja prioridad para que la computadora siga respondiendo.
- **Se pausa solo** mientras se ve una película, y en una laptop que funciona con batería (puedes cambiar ambas cosas en Ajustes > Análisis).
- **No se pierde nada.** Si la computadora se suspende o la app se cierra, el análisis sigue donde se quedó la próxima vez.
- **Una película a la vez.** Las demás esperan en la fila de análisis, abajo en la biblioteca.

Cuando termina, la película muestra **Por revisar** o **Protegida**.

## Revisar sin ver la película {#review}

Abre una película con **Revisar**. Verás:

- **Lo que los adultos deben saber**: cuántas escenas de cada tipo encontramos y qué tan fuertes son. Nunca describimos una escena.
- **La línea de tiempo**: cada bloque de color es una escena. El color, el patrón y un ícono indican el tipo de escena.
- **El panel de la escena**, a la derecha, cuando eliges una: una imagen difuminada, una nota corta, qué tan seguros estamos y qué pasa al reproducirla.

Con cada escena puedes:

1. **Aprobarla**: se omitirá (u ocultará, o silenciará, según "Al reproducir").
2. **Rechazarla**: se ve normal. Úsalo cuando nos equivocamos.
3. **Mover los bordes** un poco antes o después con los botones, o con las flechas sobre las asas (0.5 segundos; con Mayús, 5 segundos).
4. **Cambiar la categoría** o **lo que pasa** al reproducirla.
5. **Mantener para echar un vistazo**: un adulto puede ver un poco más de la imagen mientras mantiene presionado el botón. Pide el PIN, y otra vez después de 5 minutos. La imagen sigue suave y nunca se guarda.

Cada cambio se guarda en el momento. Un mensaje ofrece **Deshacer** si cambias de opinión.

**Aprobar todas** acepta todas las escenas en espera. **Marcar como revisada** es para una película que revisaste tú mismo.

> Podemos pasar algo por alto y a veces marcamos una escena que está bien. Para eso existe la revisión. También puedes marcar una escena mientras la ves (más abajo).

## Ver con los niños {#kids}

Cuando la app está bloqueada, los niños ven solo las películas que aprobaste, en mosaicos grandes. Eligen una y la película se abre en su propia ventana.

- Una película aparece para los niños solo cuando ya se analizó y se decidieron todas sus escenas.
- Si algo está mal con su lista de escenas, la película no se reproduce para los niños. Nunca se reproduce sin protección.
- Para volver a la biblioteca, presiona **Adulto** y escribe el PIN.
- Vuelve a bloquear la app con **Bloquear para niños**, abajo en la barra lateral.

## La tecla de pánico {#panic}

Si aparece algo que no debería, presiona **P** (o **Ctrl+Espacio**). La pantalla se pone negra y en silencio de inmediato.

- Presiona **P** otra vez, o **Enter**, para volver. La escena se guarda y se omite desde entonces, empezando dos segundos antes de que presionaras la tecla.
- Con la pantalla oculta, la flecha derecha adelanta 10 segundos.
- Puedes elegir otra letra en Ajustes > Reproducción.

**Marcar mientras ves (adultos).** Presiona **I** donde empieza una escena y **O** donde termina. **U** deshace la última marca. Las marcas se guardan al instante y esperan tu revisión. Estas teclas no funcionan en el modo infantil.

## Ver en tu TV {#tv}

bonis oculis no puede cambiar lo que muestran las apps de streaming en la TV. Funciona con archivos de películas que tienes. Hay dos formas de llevar una película protegida a una Fire TV (como una Hisense Fire TV).

### Lo más fácil: una copia limpia en una memoria USB con VLC

1. En bonis oculis, abre **Enviar a la TV**, elige la película y presiona **Hacer una copia limpia**. Obtienes un video nuevo sin las escenas. Tu original no cambia.
2. Copia el archivo nuevo a una memoria USB. Para películas grandes usa una memoria con formato **exFAT** (FAT32 no acepta archivos de más de 4 GB).
3. En la TV, abre la **Amazon Appstore**, busca **VLC** e instálala. Es gratis.
4. Conecta la memoria a la TV, abre VLC, entra a **Explorar** y elige la película.

Si la copia se reproduce sin sonido en tu TV, hazla otra vez con **Convertir también el sonido a AAC** activado.

### Avanzado: Kodi con una lista para Kodi (.edl)

Kodi es un reproductor gratuito que puede omitir escenas por sí solo con un pequeño archivo .edl junto a la película.

1. Kodi no está en la Amazon Appstore. En la Fire TV ve a **Configuración > Mi Fire TV > Opciones para desarrolladores** y permite apps de origen desconocido; luego instala la app **Downloader** desde la Appstore y úsala para instalar Kodi desde kodi.tv.
2. En bonis oculis, abre **Enviar a la TV** y presiona **Guardar lista para Kodi**. Junto a la película se guarda un archivo con el mismo nombre y la terminación .edl.
3. Pon la película y su archivo .edl juntos en la misma carpeta de una memoria USB o de una carpeta compartida que Kodi pueda ver.
4. Reproduce la película en Kodi. Las escenas de la lista se omiten.

> Una lista para Kodi sirve para la copia de la película con la que se hizo. Si usas otra copia, analiza esa copia.

## Lo que bonis oculis no puede hacer {#limits}

- No puede filtrar las apps de streaming de la TV (Netflix, Prime Video, Disney+ y otras) ni la televisión en vivo. Funciona con archivos de películas en tu computadora.
- No puede analizar películas protegidas contra copia (DRM), como las rentas y compras dentro de las apps de streaming.
- Es automático, así que puede pasar por alto una escena o marcar una que está bien. El gore es lo más difícil de encontrar. Revisa lo que encontramos y usa la tecla de pánico si algo se escapa.
- No decide si una película es adecuada para tu hijo o hija. Solo omite las escenas que elegiste.

## El PIN y sus límites {#pin}

El PIN reserva los ajustes, las revisiones y la biblioteca para los adultos.

- Después de 5 intentos equivocados, el teclado espera 30 segundos, y más tiempo después de cada nuevo error.
- Si olvidas el PIN, presiona **Adulto** en la pantalla infantil, luego **Olvidé mi PIN**, y escribe el código de recuperación que anotaste al configurar la app. Después recibes un código nuevo.
- El PIN es un candado familiar, no una caja fuerte. Alguien con una cuenta de administrador en esta computadora puede saltárselo, por ejemplo borrando los datos de la app. Los ajustes y las listas de escenas van firmados, así que los cambios hechos fuera de la app se notan y la película deja de contar como protegida hasta que la revises otra vez. Deja la cuenta de administrador para los adultos.

## Privacidad {#privacy}

- bonis oculis no tiene cuentas, anuncios ni estadísticas, y nunca se conecta a internet.
- Las imágenes de escenas marcadas se difuminan antes de guardarse. Nunca se escribe en el disco una imagen clara.
- Tu biblioteca, tus revisiones y tus ajustes se quedan en la carpeta de la app en esta computadora. Solo se comparten archivos cuando presionas un botón de exportar.

## ¿Qué tan preciso es? {#accuracy}

bonis oculis es automático, así que comete dos tipos de errores:

- **Escenas que se pasan**: una escena que no querías y que no detectamos. Son las más importantes, por eso la app está configurada para marcar de más antes que de menos.
- **Falsas alarmas**: algo que marcamos y que estaba bien. Las corriges en segundos con **Rechazar** durante la revisión.

Como la película se revisa antes de que alguien la vea, puedes repasar lo que encontramos. Aun así, ninguna herramienta automática encuentra todo, así que ten presente la tecla de pánico.

Para ver las cifras con tus propias películas, marca a mano todas las escenas de una película (presiona **I** y **O** mientras la ves), luego abre el menú **Más** de la película y elige **Revisar la precisión**, o ve a Ajustes > Acerca de. Verás, para cada tipo de escena, cuánto encontramos, cuánto de lo que marcamos era correcto, el tiempo que se nos pasó y las falsas alarmas, cada uno con una explicación de una línea. Una película es solo un ejemplo: revisa varias para tener una idea justa.
