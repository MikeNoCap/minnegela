import type { Locale } from './locale.js';

/** Legacy prompt-style tags ("a photo of food") still exist on blobs analysed before the calibrated vocabulary. */
export function cleanTag(tag: string): string {
  return tag.replace(/^a photo of /, '').replace(/^an? /, '').replace(/^(the )/, '').trim();
}

/**
 * Norwegian labels for the tag keys in apps/ml-worker/minnegela_ml/vocab.py. Keys are the stored English tag;
 * labels are lowercase like the keys so consumers capitalise both the same way ("Frisbeegolf med Stefan").
 */
const NB: Record<string, string> = {
  // activities
  'frisbee golf': 'frisbeegolf', frisbee: 'frisbee', 'playing guitar': 'gitarspilling', 'making music': 'musikklaging', drums: 'trommer',
  'dj set': 'dj-sett', concert: 'konsert', festival: 'festival', party: 'fest', nightclub: 'nattklubb', 'pre-party': 'vors', dinner: 'middag',
  barbecue: 'grilling', picnic: 'piknik', birthday: 'bursdag', wedding: 'bryllup', christmas: 'jul', "new year's eve": 'nyttårsaften',
  '17th of may': '17. mai', halloween: 'halloween', graduation: 'russetid', smoking: 'røyking', 'drinking beer': 'øldrikking',
  'wine tasting': 'vinsmaking', cocktails: 'cocktailer', coffee: 'kaffe', cooking: 'matlaging', baking: 'baking', hiking: 'fottur',
  camping: 'camping', skiing: 'skitur', snowboarding: 'snowboard', sledding: 'aking', 'ice skating': 'skøyter', swimming: 'bading',
  sauna: 'badstue', 'beach day': 'stranddag', 'boat trip': 'båttur', kayaking: 'padling', fishing: 'fisking', cycling: 'sykling',
  running: 'løping', football: 'fotball', basketball: 'basketball', volleyball: 'volleyball', tennis: 'tennis', golf: 'golf',
  bowling: 'bowling', climbing: 'klatring', gym: 'trening', yoga: 'yoga', 'board games': 'brettspill', 'video games': 'dataspill',
  'watching a match': 'kamp på TV', 'sports event': 'idrettsarrangement', shopping: 'shopping', market: 'marked', museum: 'museum',
  cinema: 'kino', theatre: 'teater', sightseeing: 'sightseeing', 'road trip': 'biltur', flying: 'flytur', 'train ride': 'togtur',
  'walk in the city': 'bytur', 'walk in nature': 'tur i naturen', studying: 'studering', work: 'jobb', moving: 'flytting', diy: 'oppussing',
  gardening: 'hagearbeid', photoshoot: 'fotoshoot', filming: 'filming', recording: 'innspilling', karaoke: 'karaoke', dancing: 'dansing',
  'cabin trip': 'hyttetur', sunbathing: 'soling', bonfire: 'bål',
  // scenes
  beach: 'strand', mountains: 'fjell', forest: 'skog', lake: 'innsjø', fjord: 'fjord', waterfall: 'foss', river: 'elv', snow: 'snø',
  sunset: 'solnedgang', 'northern lights': 'nordlys', 'night sky': 'stjernehimmel', fireworks: 'fyrverkeri', 'city at night': 'byen om natten',
  'city street': 'bygate', 'old town': 'gamlebyen', park: 'park', harbour: 'havn', countryside: 'landsbygda', island: 'øy', rooftop: 'takterrasse',
  balcony: 'balkong', garden: 'hage', lawn: 'plen', path: 'sti', terrace: 'terrasse', restaurant: 'restaurant', cafe: 'kafé', bar: 'bar',
  'living room': 'stue', kitchen: 'kjøkken', bedroom: 'soverom', bathroom: 'bad', 'hotel room': 'hotellrom', airport: 'flyplass',
  stadium: 'stadion', school: 'skole', church: 'kirke', castle: 'slott', 'amusement park': 'fornøyelsespark', zoo: 'dyrepark',
  'ski resort': 'skianlegg', 'swimming pool': 'svømmebasseng', tent: 'telt', rain: 'regn', underwater: 'under vann', 'aerial view': 'dronebilde',
  // food & drink
  food: 'mat', pizza: 'pizza', burger: 'burger', sushi: 'sushi', taco: 'taco', 'hot dog': 'pølse', waffles: 'vafler', cake: 'kake',
  'ice cream': 'is', breakfast: 'frokost', seafood: 'sjømat', kebab: 'kebab', snacks: 'snacks',
  beer: 'øl', wine: 'vin', cocktail: 'cocktail', shots: 'shots', champagne: 'champagne', spirits: 'sprit', soda: 'brus',
  'energy drink': 'energidrikk', tea: 'te',
  // objects
  guitar: 'gitar', synthesizer: 'synth', microphone: 'mikrofon', 'vinyl records': 'vinylplater', car: 'bil', motorcycle: 'motorsykkel',
  bicycle: 'sykkel', boat: 'båt', skis: 'ski', skateboard: 'skateboard', camera: 'kamera', flowers: 'blomster', present: 'gave',
  balloons: 'ballonger', flag: 'flagg', artwork: 'kunst', tattoo: 'tatovering', clothes: 'klær', plants: 'planter', book: 'bok', sign: 'skilt',
  // animals
  dog: 'hund', cat: 'katt', horse: 'hest', bird: 'fugl', 'cows and sheep': 'kyr og sauer', 'wild animal': 'vilt dyr', fish: 'fisk',
  // people
  selfie: 'selfie', 'group photo': 'gruppebilde', portrait: 'portrett', couple: 'par', baby: 'baby', kids: 'barn', crowd: 'folkemengde',
  'mirror selfie': 'speilselfie',
  // mundane
  'computer screen': 'dataskjerm', desk: 'skrivebord', 'music software': 'musikkprogram', 'empty room': 'tomt rom', groceries: 'dagligvarer',
  package: 'pakke', parking: 'parkering', whiteboard: 'tavle', laundry: 'klesvask', mess: 'rot', cables: 'kabler',
  // utility
  screenshot: 'skjermbilde', chat: 'chat', document: 'dokument', receipt: 'kvittering', meme: 'meme', map: 'kart', 'qr code': 'QR-kode',
  'whiteboard photo': 'tavlebilde',
  // quality anchors (never surfaced, kept complete)
  'camera photo': 'kamerabilde', 'beautiful photo': 'fint bilde', 'accidental photo': 'feilbilde',
};

/** Human label for a stored tag in the given language; unknown tags fall back to the cleaned English key. */
export function tagLabel(tag: string, locale: Locale): string {
  const key = cleanTag(tag);
  return (locale === 'nb' ? NB[key] : undefined) ?? key;
}
