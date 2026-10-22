# Viseron

Amène dans Gladys les caméras d'un serveur [Viseron](https://viseron.netlify.app/) (l'enregistreur
vidéo réseau auto-hébergé avec détection d'objets) : leur image, le mouvement détecté, les objets que
Viseron suit (personne, voiture, chien…), l'enregistrement en cours, et si elles sont en ligne. Les
événements en direct de Viseron déclenchent des scènes, avec l'image du moment, qu'une scène peut
vous envoyer. Les scènes peuvent aussi démarrer ou arrêter un enregistrement.

Testée contre un vrai serveur Viseron en Docker (3.7.0, CPU, détection d'objets darknet) avec des
caméras réseau simulées, pas encore sur une installation en service avec de vraies caméras : vos
retours sont les bienvenus sur [GitHub](https://github.com/guim31/gladys-viseron/issues) ou sur le
forum Gladys.

## Ce qu'il vous faut

- Gladys 5.1 ou plus récent.
- Viseron 3.7 ou plus récent, joignable depuis Gladys sur son port web (8888 par défaut).
- Les caméras déjà configurées dans Viseron (composant `ffmpeg` ou `gstreamer`), avec un détecteur de
  mouvement et un détecteur d'objets si vous voulez ces fonctionnalités.
- Si l'authentification est active dans Viseron (`webserver: auth:`), un utilisateur Viseron pour
  Gladys. Le rôle **read** suffit pour suivre les caméras ; le rôle **write** permet aussi à Gladys de
  lancer des enregistrements.

## Installation

1. Dans Gladys, ouvrez **Intégrations**, trouvez **Viseron** et installez-la.
2. Dans son onglet **Configuration**, renseignez :
   - **Adresse de Viseron** : l'adresse de l'ordinateur qui fait tourner Viseron, ex. `192.168.1.20`.
     Sans port, 8888 est utilisé ; ajoutez `:port` s'il a été changé, ou `https://` derrière un proxy
     inverse.
   - **Nom d'utilisateur** et **Mot de passe** : seulement si l'authentification est active dans
     Viseron. Laissez-les vides sinon.
   - **Rafraîchissement des images** : fréquence d'envoi de l'image de chaque caméra à Gladys (de 10
     secondes à 15 minutes, 1 minute par défaut). Un mouvement ou un objet détecté en envoie aussi une
     aussitôt.
   - **Langue des noms** : la langue des noms de fonctionnalités donnés à l'ajout d'une caméra.
3. Enregistrez, puis ouvrez l'onglet **Découverte** : un appareil par caméra. Ajoutez ceux que vous
   voulez.
4. **Vérifier la connexion** montre ce que l'intégration lit : la version de Viseron, si les
   événements en direct arrivent, chaque caméra, si elle est en ligne, enregistre, et les objets
   qu'elle suit.

## Les appareils Gladys

Chaque caméra Viseron devient une caméra Gladys, nommée comme dans Viseron, avec :

| Fonctionnalité            | Ce que c'est                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Image**                 | L'image de la caméra, envoyée au rythme choisi et aussitôt sur mouvement ou objet.  |
| **Mouvement**             | 1 tant que le détecteur de mouvement de Viseron voit du mouvement, sinon 0.         |
| **Objet détecté**         | 1 tant qu'un objet suivi par Viseron est dans l'image, sinon 0.                     |
| **Détection personne**, … | Une par étiquette que Viseron suit sur la caméra (personne, voiture, chien…).       |
| **Enregistrement**        | 1 pendant un enregistrement. Un interrupteur : démarre ou arrête un enregistrement. |

Les fonctionnalités suivent la configuration de Viseron : une caméra sans détecteur de mouvement n'a
pas de **Mouvement**. Une étiquette ajoutée plus tard dans Viseron apparaît après **Mettre à jour**
dans l'onglet Découverte. Une caméra dont le flux est perdu, ou arrêtée dans Viseron, apparaît
injoignable dans Gladys.

**Caméras ajoutées avec la version 1.0.x** : elles avaient une fonctionnalité **En ligne** du type
Gladys « caméra activée », que Gladys 5.2 utilise comme mode confidentialité de la caméra (à 0, Gladys
refuse ses images). Ouvrez l'onglet Découverte de l'intégration et cliquez sur **Mettre à jour** sur
chaque caméra : la fonctionnalité disparaît. D'ici là, l'intégration la remet à 1 une fois au
démarrage, pour que les images continuent d'arriver.

## Widget du tableau de bord

**Caméra Viseron** affiche l'image d'une caméra, le mouvement, les objets en vue (ex. « Chien,
Personne »), l'enregistrement et l'état en ligne, et deux boutons : **Enregistrer** (ou **Arrêter
l'enregistrement**) et **Nouvelle image**.

## Scènes

### Déclencheurs

- **Viseron : objet détecté** : Viseron commence à voir un objet qu'il suit. Filtres : la caméra (vide
  = toutes), l'objet (étiquette, ex. `person`) et la zone (vide = toutes), écrits comme dans la
  configuration de Viseron. Variables : le nom de la caméra, l'objet, la zone (vide pour toute
  l'image) et la confiance en %. L'image du moment est d'abord envoyée à Gladys. Un objet suivi à la
  fois sur toute l'image et dans une zone déclenche une fois pour chacune : filtrez sur la zone pour
  n'en garder qu'une.
- **Viseron : mouvement détecté** : le détecteur de mouvement d'une caméra commence à voir du
  mouvement. Filtre : la caméra. Variable : le nom de la caméra. L'image du moment est d'abord envoyée.
- **Viseron : caméra hors ligne** : une caméra active dans Viseron perd son flux depuis 30 secondes,
  ou Viseron lui-même ne répond plus. Rien pour une caméra arrêtée dans Viseron.

### Actions

- **Viseron : enregistrer** : **Démarrer** lance un enregistrement manuel sur une caméra, **Arrêter**
  l'arrête. Viseron le refuse pour une caméra hors ligne et, avec l'authentification, pour un
  utilisateur sans le rôle write.

L'action **Envoyer une image de caméra** du cœur envoie la dernière image d'une caméra : juste après
**Viseron : objet détecté** ou **Viseron : mouvement détecté**, c'est l'image de ce moment.

### Idées de scènes

- **Quelqu'un à la porte** : **Viseron : objet détecté**, caméra « Entrée », objet `person` →
  **Envoyer une image de caméra** de cette caméra sur votre téléphone, avec
  `{{triggerEvent.data.score}}` % dans le texte.
- **Voiture dans l'allée la nuit** : **Viseron : objet détecté**, objet `car`, zone `driveway` →
  allumer la lumière extérieure cinq minutes.
- **Porte ouverte en votre absence** : un détecteur d'ouverture s'ouvre et personne n'est là →
  **Viseron : enregistrer**, Démarrer, sur la caméra de l'entrée ; Arrêter deux minutes plus tard.
- **Caméra perdue** : **Viseron : caméra hors ligne** → envoyer un message avec le nom de la caméra.

## Dépannage

- **« Viseron ne répond pas à cette adresse »** : ouvrez `http://<adresse>:8888` dans un navigateur.
  Vérifiez le port et qu'aucun pare-feu ne bloque Gladys.
- **« Quelque chose répond, mais pas comme Viseron »** : l'adresse ou le port mène à un autre service.
  Saisissez l'adresse de Viseron, sans chemin de page.
- **« Viseron demande une connexion, ou refuse l'identifiant ou le mot de passe »** :
  l'authentification est active dans Viseron. Saisissez un utilisateur Viseron (pas un jeton d'accès
  personnel), ou vérifiez le mot de passe.
- **Pas de fonctionnalité objet ou mouvement** : la caméra n'a pas de détecteur d'objets ou de
  mouvement dans la configuration de Viseron, ou Viseron ne l'a pas démarré (voir ses logs).
- **« Pas d'événements en direct » dans Vérifier la connexion** : le WebSocket de Viseron ne s'ouvre
  pas (un proxy inverse doit laisser passer les WebSockets sur `/websocket`). Les états ne sont alors
  lus qu'une fois par minute, et aucun déclencheur ne part, sauf **caméra hors ligne**.
- **Plus de détails** : les logs de l'intégration (Intégrations → Viseron → Logs) ; mettez `LOG_LEVEL`
  à `debug` pour voir chaque requête.

## Limites

- Pas de vidéo en direct : Gladys affiche des images, envoyées au rythme choisi (Gladys garde 12
  images par minute et par caméra au plus). Le direct et les enregistrements se regardent dans
  Viseron.
- Étiquettes et zones se filtrent telles qu'écrites dans Viseron : les filtres de scène ne comparent
  que du texte.
- Au plus 12 étiquettes par caméra deviennent des fonctionnalités.
- Les enregistrements passés, la reconnaissance faciale et de plaques, le PTZ, et démarrer ou arrêter
  une caméra ne sont pas couverts.
- Un serveur Viseron par intégration.
- Testée avec Viseron 3.7.0 en Docker et des caméras simulées, sans installation réelle : vos retours
  sont les bienvenus.

Cette intégration n'est affiliée ni à Viseron ni à ses auteurs.
