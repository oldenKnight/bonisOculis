# Ayuda de bonis oculis

bonis oculis analiza una película una vez, aquí en esta computadora, y anota dónde están las escenas que no quieres ver. Cuando alguien le da Ver, esas escenas se omiten. No se envía nada a ningún lado.

## Qué necesitas {#requirements}

- **Windows:** Windows 10 (versión 1809 o posterior) o Windows 11, de 64 bits.
- **Mac con Apple Silicon** (M1 o posterior): macOS 14 Sonoma o posterior. Usa la descarga cuyo nombre termina en **arm64**.
- **Mac con Intel:** macOS 12 Monterey o posterior. Usa la descarga cuyo nombre termina en **x64**. Para saber qué Mac tienes, abre el menú Apple › **Acerca de esta Mac**: dice **Chip** (Apple Silicon) o **Procesador** (Intel).
- Al menos **4 GB de memoria** y **3 GB libres en el disco**, más espacio para las copias limpias que hagas.
- Una computadora con chip de video analiza y hace copias limpias más rápido. Sin él también funciona, solo más despacio.
- En computadoras de antes de 2013, más o menos, se omiten las comprobaciones que escuchan el diálogo; la imagen y los subtítulos sí se analizan.

**Mac con Apple Silicon y macOS 12 o 13.** El reproductor que trae bonis oculis para estas Mac necesita macOS 14 o posterior, así que la Mac no abrirá la app hasta que la actualices. Actualizar es gratis: menú Apple › **Configuración del Sistema** › **General** › **Actualización de software**. Mientras tanto, bonis oculis no puede reproducir películas en esa Mac.

## Antes de instalar {#install}

Esta primera versión de bonis oculis todavía no está firmada por Apple ni por Microsoft, así que tu computadora pregunta antes de abrirla la primera vez. Solo lo haces una vez. bonis oculis nunca se conecta a internet, así que no pasa nada si tu firewall la bloquea.

**En una Mac con macOS 15 (Sequoia) o posterior**

1. Abre el archivo .dmg que descargaste y arrastra **bonis oculis** a la carpeta **Aplicaciones**.
2. Abre **Aplicaciones** y haz doble clic en **bonis oculis**. Un mensaje dice que no se abrió. Elige **OK** o **Listo**. (Hacer clic con Control y elegir **Abrir** ya no funciona en estas versiones).
3. Abre el menú Apple › **Configuración del Sistema** › **Privacidad y seguridad**.
4. Baja hasta **Seguridad**. Junto a "Se bloqueó bonis oculis", elige **Abrir de todos modos**.
5. Escribe la contraseña de tu Mac y elige **Abrir de todos modos** una vez más.

Desde entonces se abre normalmente.

**En una Mac con macOS 14 o anterior**

1. Arrastra **bonis oculis** a la carpeta **Aplicaciones**.
2. Mantén presionada la tecla Control, haz clic en la app y elige **Abrir**.
3. En el mensaje que aparece, elige **Abrir** otra vez.

**En Windows 10 u 11**

1. Si tu navegador dice que el archivo no se descarga con frecuencia, elige **Conservar** (en Edge: los tres puntos › **Conservar** › **Mostrar más** › **Conservar de todos modos**).
2. Haz doble clic en el instalador.
3. Si una ventana azul dice "Windows protegió su PC" (Microsoft Defender SmartScreen), haz clic en **Más información**.
4. Haz clic en **Ejecutar de todas formas**.

## Para empezar {#start}

La primera vez que se abre, bonis oculis te pide tu idioma, un PIN de adulto, cuánto omitir y una primera película.

- **El PIN** reserva la biblioteca, las revisiones y los ajustes para los adultos. Elige uno que no sea fácil de adivinar (no 1234 ni 0000).
- **El código de recuperación** se muestra una sola vez. Anótalo y guárdalo lejos de los niños. Es la única forma de volver a entrar si olvidas el PIN.
- **Los niveles** dicen qué tan seguros debemos estar antes de omitir una escena. Puedes cambiarlos cuando quieras en Ajustes › Protección.

## Cómo funciona el análisis {#scanning}

Cuando agregas una película, bonis oculis la analiza una vez y hace una lista de las escenas que se omitirán. Lee los subtítulos, escucha los diálogos y observa la imagen y el sonido. La película nunca se modifica.

- **Cuánto tarda.** En una laptop común, una película de dos horas tarda entre 30 y 60 minutos si tiene subtítulos, y más si no los tiene. El **Análisis minucioso** de Ajustes › Análisis es más lento y mira más escenas.
- **Trabaja en segundo plano.** Puedes seguir usando la app. El análisis tiene prioridad baja para que la computadora siga respondiendo.
- **Se pausa solo** mientras se ve una película, y en una laptop que funciona con batería (puedes cambiar ambas cosas en Ajustes › Análisis).
- **No se pierde nada.** Si la computadora se suspende o la app se cierra, el análisis sigue donde se quedó la próxima vez.
- **Una película a la vez.** Las demás esperan en la cola de análisis, abajo en la biblioteca.

Cuando termina el análisis, la película muestra **Por revisar**. Una película nunca llega a la pantalla de los niños hasta que un adulto la revisa, aunque el análisis no haya encontrado nada.

## Revisar sin ver la película {#review}

Abre una película con **Revisar**. Verás:

- **Lo que los padres deben saber**: para cada tipo de escena, qué encontramos y qué pasará con ello. **No se analizó** quiere decir que ese tipo está apagado en tus niveles (o que se saltó esa parte del análisis), así que no lo buscamos. **No se encontró** quiere decir que lo buscamos y no encontramos nada. Nunca describimos una escena.
- **La línea de tiempo**: cada bloque de color es una escena. El color, el patrón y un ícono indican el tipo de escena. Pasa el puntero sobre la leyenda para leer qué significa cada tipo.
- **El panel de la escena**, a la derecha, cuando eliges una escena: una imagen difuminada, una nota breve, qué tan seguros estamos y qué pasa cuando se reproduce.

Para cada escena puedes:

1. **Omitir esta escena**: se omitirá (o se cubrirá, o se silenciará, según diga "Al reproducir").
2. **Dejar que se vea**: se reproduce normalmente. Úsalo cuando nos equivocamos.
3. **Mover los bordes** un poco antes o después con los botones, o con las flechas sobre las asas (0.5 segundos; con Mayús, 5 segundos).
4. **Cambiar la categoría** o **lo que pasa** al reproducirla.
5. **Mantén para echar un vistazo**: después de escribir el PIN, y solo mientras mantienes presionado el botón, ves la imagen real de la película, apenas difuminada. Vuelve a pedir el PIN después de 5 minutos. No se guarda nada.

Algunas escenas dicen **Por debajo de tu nivel: se verá a menos que la omitas**. Las encontramos, pero no estamos lo bastante seguros para el nivel que elegiste, así que se ven. Presiona **Omitir esta escena** si quieres quitarlas.

**Solo para esta película.** Los niveles de Ajustes se aplican a todas las películas. Para ser más estricto o más flexible con una sola, presiona **Solo para esta película** en su revisión (o en el resumen antes de Ver). **Usar mis niveles de siempre** lo deshace. El reproductor, la lista para Kodi y la copia limpia siguen los niveles propios de la película. Las escenas que ya decidiste se quedan como las decidiste.

**Teclas.** Cuando eliges una escena, el teclado pasa al panel. **S** omite la escena, **L** deja que se vea, **N** va a la siguiente escena y **P** a la anterior. En la línea de tiempo, **Inicio** y **Fin** saltan al corte de escena más cercano.

Cada cambio se guarda en cuanto lo haces. Un mensaje abajo a la izquierda ofrece **Deshacer** durante unos segundos.

**Omitir las N escenas** omite cada escena en espera, aun las que están por debajo de tu nivel. **Marcar como revisada** es para una película que revisaste por tu cuenta.

**Un archivo de escenas importado** (de otra familia, o hecho para otra copia) llega con todas las escenas en espera. La película muestra **Por revisar: lista importada** hasta que la revises y presiones **Usar esta lista para los niños**.

**Cuando no se encontró nada**, la película igual te espera. Si conoces la película, presiona **Se ve bien: aprobar para niños**. Solo entonces los niños la pueden ver.

> Se nos pueden pasar cosas, y a veces marcamos una escena que está bien. Para eso existe la revisión. También puedes marcar una escena mientras la ves (consulta [La tecla de pánico](#panic)).

## Ver con los niños {#kids}

Cuando la app está bloqueada, los niños ven solo las películas que aprobaste, en mosaicos grandes. Presionan una y la película se abre en su propia ventana.

- Una película aparece para los niños solo cuando ya se analizó y un adulto decidió cada escena (o aprobó una película donde no se encontró nada).
- Si algo anda mal con su lista de escenas, la película no se reproduce para los niños. En modo infantil nunca se reproduce sin protección.
- Para volver a la biblioteca, presiona **Adulto** y escribe el PIN.
- Bloquea la app con **Bloquear para niños** en la barra lateral. También se bloquea sola después de 10 minutos sin uso. Cámbialo en Ajustes › PIN (5, 10 o 30 minutos, o nunca). Un mensaje te avisa 30 segundos antes. Mientras se ve una película en modo de adulto la app no se bloquea, y lo que hagas en la página Reproduciendo no cuenta como estar presente. Si el tiempo se acabó durante la película, la app se bloquea en cuanto la película llega al final, presionas **Detener** o cierras la ventana de la película. Cuando la app abre en modo infantil (lo habitual), también se bloquea al cambiar a otra app: consulta **Bloquear al cambiar a otra app** en Ajustes › PIN.

**Antes de ver en modo de adulto** un resumen breve dice qué pasará, por ejemplo "Se omitirán 12 escenas · 1 se silenciará · 2 se verán (debajo de tu nivel)". Presiona **Ver**, o **Revisar primero** para volver a mirar. En modo infantil la película empieza de inmediato.

**Si una lista de escenas está dañada** (por ejemplo, después de un problema con el disco) y no se puede usar la copia de respaldo, la película muestra **Requiere atención: lista de escenas dañada** y nunca aparece como protegida. Los niños no la pueden ver. En modo de adulto, Ver pregunta antes de reproducirla sin protección. Analízala otra vez para arreglarlo.

## La tecla de pánico {#panic}

Si aparece algo que no debería, presiona **P** (o **Ctrl+Espacio**). La pantalla se pone negra y en silencio de inmediato.

- Presiona **P** otra vez, o **Enter**, para volver. La escena se guarda y se omite desde entonces, empezando dos segundos antes de que presionaras la tecla.
- Con la pantalla oculta, la flecha derecha adelanta 10 segundos.
- Puedes elegir otra letra en Ajustes › Reproducción.
- Cuando la usa un niño, la tarjeta de la película en la biblioteca dice **Se ocultó un momento durante la reproducción: échale un vistazo** hasta que abras su revisión. La parte oculta se sigue omitiendo de todas formas.

**Marcar mientras ves (adultos).** Presiona **I** donde empieza una escena y **O** donde termina. **U** deshace la última marca. Las marcas se guardan de inmediato y esperan tu revisión. Estas teclas no funcionan en modo infantil.

## Ver en tu TV {#tv}

bonis oculis no puede cambiar lo que muestran las apps de streaming en la TV. Funciona con archivos de películas que tienes. Estos pasos son para una Fire TV, como una Hisense Fire TV o un Fire TV Stick. Los menús pueden cambiar un poco entre modelos.

Los archivos para la TV siguen tus niveles igual que el reproductor de la app: una escena por debajo de tu nivel no se corta ni se anota; una escena que omites, sí.

### Lo más fácil: una copia limpia en una memoria USB con VLC

**En la computadora**

1. En bonis oculis, abre **Enviar a la TV**, elige la película y presiona **Hacer una copia limpia**. Obtienes un archivo de video nuevo sin las escenas omitidas. Tu original queda igual. Primero la app prueba unos segundos de la película y te dice más o menos cuánto va a tardar la copia. Esto crea un archivo nuevo; tarda un buen rato en computadoras sin chip de video (a menudo cerca de una hora para una película de dos horas en una laptop no tan nueva). Puedes seguir usando la computadora, y **Cancelar** no deja nada a medias.
2. Copia el archivo nuevo a una memoria USB con formato **exFAT** (lo mejor) o **FAT32**. FAT32 no admite archivos de más de 4 GB. Una memoria nueva casi siempre viene lista. Si necesitas darle formato, hazlo en la computadora, antes de copiar la película.

**En la TV, una sola vez**

3. Presiona el botón de Inicio, abre la **Appstore** (Amazon Appstore), busca **VLC** e instálala. Es gratis.

**Cada vez**

4. Conecta la memoria a la TV. Si la TV ofrece **formatear** la memoria o usarla como **almacenamiento interno**, di que no: elige **Ver**, **Cancelar** o **Ahora no**. Formatear borra la película.
5. Abre VLC, entra a **Explorar**, elige la memoria por su nombre y elige la película.

**Qué tiene la copia.** No queda ni un cuadro de una escena cortada, y el sonido sigue al mismo tiempo que la imagen después de cada corte. La imagen se vuelve a hacer como video H.264 en un archivo .mp4, que las TV y VLC reproducen. Se conservan todas las pistas de sonido (cada idioma), siempre en AAC, así que ya no necesitas **Convertir también el sonido a AAC**. Se conserva el sonido envolvente hasta 5.1. Los subtítulos no se incluyen en la copia limpia, porque podrían mostrar las palabras de una escena cortada. Una película en HDR se convierte a colores normales, así que puede verse un poco más apagada. Hacer la copia tarda en una computadora sin chip de video; antes de empezar, bonis oculis mide cuánto tardará en esta computadora y muestra el tiempo que falta mientras trabaja.

### Avanzado: Kodi con una lista de Kodi (.edl)

Kodi es un reproductor gratuito que omite escenas por sí mismo, con un archivo .edl pequeño junto a la película. Conservas la película original. Kodi no está en la Amazon Appstore, así que la primera vez lleva unos pasos más.

**En la TV, una sola vez: activa las Opciones para desarrolladores**

1. Presiona el botón de Inicio y abre **Configuración** (el engrane).
2. Abre **Dispositivo y software** (en un Fire TV Stick: **Mi Fire TV**) y luego **Acerca de**.
3. Selecciona el nombre de tu TV o de tu stick (la primera línea) **7 veces** seguidas. Un mensaje dice que ya eres desarrollador.
4. Regresa un paso. **Opciones para desarrolladores** ya aparece en la lista.

**En la TV, una sola vez: instala Downloader y luego Kodi**

5. Abre la **Appstore**, busca **Downloader** (la app naranja de AFTVnews) e instálala. Instálala primero: el paso siguiente solo muestra apps que ya están instaladas.
6. Ve a **Configuración** › **Dispositivo y software** (o **Mi Fire TV**) › **Opciones para desarrolladores** › **Instalar apps desconocidas** y activa **Downloader**. Si Downloader no aparece en la lista, actualiza la TV en **Configuración** › **Dispositivo y software** › **Acerca de** › **Buscar actualizaciones** y vuelve a intentarlo.
7. Abre Downloader, escribe `kodi.tv/download` en su cuadro de dirección y elige **Ir**.
8. Elige **Android** y luego **ARMV7A (32BIT)**. La mayoría de las Fire TV no puede instalar la versión de 64 bits.
9. Cuando termine la descarga, elige **Instalar**. Después elige **Eliminar** para borrar el archivo de instalación. Kodi ya está con tus apps.

**En la computadora**

10. En bonis oculis, abre **Enviar a la TV** y presiona **Guardar lista para Kodi**. Se guarda un archivo con el mismo nombre de la película y la terminación .edl.
11. Copia la película y su archivo .edl juntos a la misma carpeta de la memoria USB. Deja los dos nombres exactamente iguales, salvo la terminación.

**Cada vez**

12. Conecta la memoria a la TV. Si la TV ofrece formatearla, di que no, como arriba.
13. Abre Kodi. La primera vez pide permiso para usar el almacenamiento de la TV: elige **Permitir**.
14. Ve a **Videos** › **Archivos** › **Agregar videos…** (o **Añadir vídeos…**, según el idioma de Kodi) › **Explorar**, elige la memoria USB por su nombre y luego **Aceptar**, y **Aceptar** otra vez. (Kodi en una Fire TV no muestra la memoria hasta que la agregas así. Se hace una vez por memoria).
15. Abre la memoria en **Videos** › **Archivos** y reproduce la película. Las escenas de la lista se omiten.

> Una lista de Kodi va con la copia de la película para la que se hizo. Si usas otra copia de la película, analiza esa copia.

## Lo que bonis oculis no puede hacer {#limits}

- No puede filtrar las apps de streaming de la TV (Netflix, Prime Video, Disney+ y otras) ni la TV en vivo. Funciona con archivos de películas en tu computadora.
- No puede analizar películas protegidas contra copia (DRM), como las rentas y compras dentro de las apps de streaming.
- Es automático, así que puede pasar por alto una escena o marcar una que está bien. La violencia gráfica es lo más difícil de encontrar. Revisa lo que encontramos y usa la tecla de pánico si algo se escapa.
- **Personas frente a una máquina.** Servicios como ClearPlay o Common Sense Media tienen personas que ven cada película. bonis oculis usa un análisis automático más tu propia revisión, así que se puede equivocar de formas en que una persona que la ve no lo haría.
- **Sin clasificación por edad.** No dice que una película sea adecuada para una edad. Solo tú conoces a tu hijo o hija, así que solo omite las escenas que elegiste.

## El PIN y sus límites {#pin}

El PIN reserva los ajustes, las revisiones y la biblioteca para los adultos.

- Después de 5 intentos fallidos, el teclado del PIN espera 30 segundos, y más tiempo con cada nuevo intento fallido.
- Si olvidas el PIN, presiona **Adulto** en la pantalla infantil, luego **Olvidé mi PIN**, y escribe el código de recuperación que anotaste al empezar. Después recibes un código nuevo.
- **Actividad** (Ajustes › PIN) muestra, solo a los adultos, cuándo se desbloqueó la app, los PIN equivocados, los cambios de ajustes y niveles, las películas vistas sin protección, los usos de la tecla de pánico y tus aprobaciones. Se guarda solo en esta computadora.
- Si desaparece el archivo que guarda el PIN, la app no ofrece crear uno nuevo. Se queda bloqueada y pide el código de recuperación. Para eso se guarda una segunda copia de la comprobación del código en otro archivo.
- El PIN es un candado familiar, no una caja fuerte. Alguien con una cuenta de administrador en esta computadora puede saltárselo. Por ejemplo, borrar los dos archivos del PIN reinicia la app. Los ajustes y las listas de escenas están firmados, así que los cambios hechos fuera de la app se notan: la película muestra **Por revisar: la lista cambió fuera de la app** y los niños no la pueden ver hasta que la revises y presiones **Usar esta lista para los niños**. Deja la cuenta de administrador para los adultos.

## Privacidad {#privacy}

- bonis oculis no tiene cuenta, ni anuncios, ni estadísticas, y nunca se conecta a internet.
- Las imágenes de las escenas marcadas se difuminan antes de guardarse. Nunca se escribe en el disco una imagen nítida. **Mantén para echar un vistazo** muestra la imagen real solo mientras lo mantienes presionado, y no la guarda. Una excepción: para una película protegida cuyo primer minuto no tiene ninguna escena marcada, la tarjeta de la biblioteca muestra una imagen nítida de ese minuto, guardada en la carpeta de la app.
- Tu biblioteca, tus revisiones, la actividad y los ajustes se quedan en la carpeta de la app en esta computadora. Los archivos solo se comparten cuando presionas un botón de exportar.
- La primera vez que se abre cada versión, bonis oculis comprueba en segundo plano que sus programas y archivos de detección incluidos sean exactamente los que traía. Si alguno no lo es, la biblioteca dice **Requiere atención: un archivo incluido está dañado** y lo nombra. Vuelve a instalar la app.

## ¿Qué tan preciso es? {#accuracy}

bonis oculis es automático, así que comete dos tipos de errores:

- **Omisiones**: una escena que no querías y que no detectamos. Son las que más importan, por eso la app está ajustada para detectar de más antes que de menos.
- **Falsas alarmas**: algo que marcamos y estaba bien. Las corriges en unos segundos con **Dejar que se vea** durante la revisión.

Como la película se analiza antes de que alguien la vea, puedes revisar lo que encontramos. Aun así, ninguna herramienta automática lo detecta todo, así que ten presente la tecla de pánico.

**Comprobar la precisión** (en el menú **Más** de la película, o en Ajustes › Acerca de) compara el **análisis automático**, tal como estaba antes de tu revisión, con una lista de escenas hecha a mano por alguien que vio la película completa. Esa lista puede venir de **Marcar a mano** (menú **Más** de la película): la película completa se reproduce sin omitir nada, presionas **I** y **O** alrededor de cada escena y eliges su tipo, y las marcas se guardan aparte de la lista de la película, así que nunca cambian lo que ven los niños. Luego presiona **Usar mis marcas a mano de esta película** (también puedes guardarlas como .bonis.json). O elige un archivo de escenas que alguien más marcó a mano. La lista de la propia película no sirve, porque tu revisión y tus marcas ya están en ella; la app la rechaza. Verás, para cada tipo de escena, cuánto detectamos, cuánto de lo que marcamos era correcto, el tiempo que se nos pasó y las falsas alarmas, cada uno con una explicación de una línea. Una película es solo un ejemplo: comprueba varias para tener una idea justa.
