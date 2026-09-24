# Trainternet

App web mobile pour cartographier la qualité du réseau internet le long d'un trajet en train.

## Mise en route

1. Exécuter `schema.sql` puis `guest_access.sql` dans le SQL Editor du projet Supabase (une seule fois chacun).
2. Ouvrir l'app (servie en HTTPS via GitHub Pages).
   - **Avec un compte** : enregistrer ses trajets, les consulter et générer des prévisions.
   - **En invité** : consulter la carte générale de couverture (pings de tous les trajets, agrégés par cases d'environ 200 m) et obtenir la prévision sur un itinéraire connu.
3. Pendant un enregistrement, garder l'écran allumé et l'onglet au premier plan.

## Données visibles par les invités

Les tables restent protégées par RLS. Les invités passent uniquement par les fonctions de `guest_access.sql` :
- la carte agrège les pings par case, sans trace individuelle, sans date ni identifiant ;
- les **trajets nommés** (au moins 10 pings) deviennent des itinéraires publics, exposés avec des temps relatifs au départ plutôt qu'avec leur horodatage réel. Un trajet sans nom reste privé.

## Réglages

Intervalle entre pings, timeout, taille de la fenêtre glissante et seuils de couleur sont réglables depuis l'écran "Réglages" de l'app (comptes uniquement).
