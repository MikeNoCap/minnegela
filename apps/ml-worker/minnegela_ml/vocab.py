"""Zero-shot tag vocabulary (DESIGN §6.3).

Each entry is one *tag key* (what gets stored in `blobs.tags` and shown in titles), a category, and a
few prompts whose text embeddings are averaged (prompt ensembling). Keys are short lowercase phrases
that read well after capitalisation in a title: "Frisbee golf with Stefan and Åsmul".

Categories drive the consumers:
  activity  what people were doing            -> titles ("{Activity} with {Names}"), interest
  scene     where it was                      -> titles when no activity, interest
  food/drink/object/animal   what is in it    -> interest, search chips
  people    composition                       -> nothing yet (kept for filters)
  mundane   home-office / screen / errand shots -> interest penalty
  utility   screenshots, documents, receipts   -> is_utility (excluded from events)
  quality   aesthetic anchors                  -> quality.aesthetic only, never surfaced as a tag

Bump VOCAB_VERSION whenever keys change: ml.tag_stats are keyed by it and the retag job recomputes.
The vocabulary lives only here; TS consumers read the category that is stored next to each tag.
"""
from __future__ import annotations

from dataclasses import dataclass

VOCAB_VERSION = 3

CATEGORIES = ("activity", "scene", "food", "drink", "object", "animal", "people", "mundane", "utility", "quality")
# Categories that count as "specific content" for titles and the interest score, in title preference order.
TITLE_CATEGORIES = ("activity", "scene", "food", "drink", "animal", "object")


@dataclass(frozen=True)
class Tag:
    key: str
    cat: str
    prompts: tuple[str, ...]


def _t(key: str, cat: str, *prompts: str) -> Tag:
    return Tag(key, cat, prompts or (f"a photo of {key}",))


VOCAB: tuple[Tag, ...] = (
    # ---------------------------------------------------------------- activities
    _t("frisbee golf", "activity", "a person throwing a frisbee disc in a park", "a person holding a colourful plastic disc golf disc", "a metal disc golf basket with chains", "friends playing disc golf between trees"),
    _t("frisbee", "activity", "a person throwing a frisbee", "a frisbee flying through the air", "a person catching a frisbee on a lawn"),
    _t("playing guitar", "activity", "a photo of someone playing guitar", "a person holding an electric guitar", "a person playing an acoustic guitar"),
    _t("making music", "activity", "a photo of people making music in a rehearsal room", "a band playing instruments", "a person at a synthesizer"),
    _t("drums", "activity", "a photo of someone playing drums", "a drum kit"),
    _t("dj set", "activity", "a photo of a dj playing at a party", "a dj booth with turntables"),
    _t("concert", "activity", "a photo of a concert", "a band on stage with stage lights", "a crowd at a live music show"),
    _t("festival", "activity", "a photo of a music festival", "a festival crowd in front of a big stage", "people camping at a festival"),
    _t("party", "activity", "a photo of a house party", "people dancing at a party", "friends partying with drinks at night"),
    _t("nightclub", "activity", "a photo of a nightclub", "people dancing in a dark club with lights"),
    _t("pre-party", "activity", "a photo of friends drinking in a living room before going out", "people sitting around a table with beers and cards"),
    _t("dinner", "activity", "a photo of friends having dinner together", "people eating at a dinner table", "a dinner party"),
    _t("barbecue", "activity", "a photo of a barbecue", "grilling food on a grill outdoors", "people grilling in a garden"),
    _t("picnic", "activity", "a photo of a picnic", "people sitting on a blanket in a park with food"),
    _t("birthday", "activity", "a photo of a birthday party", "a birthday cake with candles", "someone blowing out candles on a cake", "birthday balloons and decorations"),
    _t("wedding", "activity", "a photo of a wedding", "a bride and groom", "wedding guests at a ceremony"),
    _t("christmas", "activity", "a photo of christmas", "a christmas tree with presents", "a christmas dinner table"),
    _t("new year's eve", "activity", "a photo of new year's eve celebration", "people celebrating new year with champagne", "fireworks at midnight on new year's eve"),
    _t("17th of may", "activity", "a photo of norwegian constitution day", "people in bunad celebrating 17 mai", "a parade with norwegian flags"),
    _t("halloween", "activity", "a photo of a halloween party", "people in halloween costumes"),
    _t("graduation", "activity", "a photo of a graduation", "russ celebration with red overalls", "people in graduation caps"),
    _t("smoking", "activity", "a photo of someone smoking", "a person rolling a joint", "friends smoking on a balcony", "a person smoking a cigarette"),
    _t("drinking beer", "activity", "a photo of friends drinking beer", "people toasting with beer glasses", "a person holding a beer"),
    _t("wine tasting", "activity", "a photo of people drinking wine", "friends toasting with wine glasses"),
    _t("cocktails", "activity", "a photo of people drinking cocktails at a bar", "a bartender making cocktails"),
    _t("coffee", "activity", "a photo of a coffee at a cafe", "a cup of coffee on a table", "a latte with latte art"),
    _t("cooking", "activity", "a photo of someone cooking", "people cooking together in a kitchen", "food being prepared on a stove"),
    _t("baking", "activity", "a photo of baking", "dough on a kitchen counter", "freshly baked bread"),
    _t("hiking", "activity", "a photo of people hiking", "a hiker on a mountain trail", "hikers with backpacks on a ridge"),
    _t("camping", "activity", "a photo of camping", "a tent pitched in nature", "a campfire at night", "people around a campfire"),
    _t("skiing", "activity", "a photo of skiing", "a skier on a slope", "cross country skiing in the forest", "people at a ski resort"),
    _t("snowboarding", "activity", "a photo of snowboarding", "a snowboarder in a park"),
    _t("sledding", "activity", "a photo of sledding", "people on a sled in the snow"),
    _t("ice skating", "activity", "a photo of ice skating", "people skating on a frozen lake"),
    _t("swimming", "activity", "a photo of people swimming", "people jumping into the water", "swimming in a lake in summer"),
    _t("sauna", "activity", "a photo of a sauna", "people in a sauna", "a floating sauna by the fjord"),
    _t("beach day", "activity", "a photo of people at the beach", "sunbathing on a beach", "friends on a beach with towels"),
    _t("boat trip", "activity", "a photo of people on a boat", "a boat on the fjord", "sailing on a sailboat", "friends on a motorboat"),
    _t("kayaking", "activity", "a photo of kayaking", "a kayak on the water", "paddling a canoe"),
    _t("fishing", "activity", "a photo of fishing", "a person holding a fishing rod", "a caught fish"),
    _t("cycling", "activity", "a photo of cycling", "people on bicycles", "a bike ride"),
    _t("running", "activity", "a photo of running", "a runner in a race with a bib number", "people jogging"),
    _t("football", "activity", "a photo of people playing football", "a soccer match", "a football pitch"),
    _t("basketball", "activity", "a photo of basketball", "people playing basketball on a court"),
    _t("volleyball", "activity", "a photo of beach volleyball", "people playing volleyball"),
    _t("tennis", "activity", "a photo of tennis", "a tennis court", "playing padel"),
    _t("golf", "activity", "a photo of golf", "a person swinging a golf club", "a golf course"),
    _t("bowling", "activity", "a photo of bowling", "a bowling alley"),
    _t("climbing", "activity", "a photo of rock climbing", "a bouldering gym", "a climber on a wall"),
    _t("gym", "activity", "a photo of a gym", "someone lifting weights", "a workout at the gym"),
    _t("yoga", "activity", "a photo of yoga", "people doing yoga"),
    _t("board games", "activity", "a photo of people playing board games", "a board game on a table", "playing cards with friends"),
    _t("video games", "activity", "a photo of people playing video games", "a gaming console and controllers", "a gaming session on a couch"),
    _t("watching a match", "activity", "a photo of friends watching a football match on tv", "a sports bar with a big screen"),
    _t("sports event", "activity", "a photo of a sports event in a stadium", "spectators in a stadium", "a match seen from the stands"),
    _t("shopping", "activity", "a photo of shopping", "people in a shopping mall", "shopping bags"),
    _t("market", "activity", "a photo of a market", "a flea market", "a farmers market with stalls"),
    _t("museum", "activity", "a photo of a museum", "people looking at art in a gallery", "a museum exhibition"),
    _t("cinema", "activity", "a photo of a cinema", "a movie theatre screen", "people at the movies"),
    _t("theatre", "activity", "a photo of a theatre performance", "actors on a stage"),
    _t("sightseeing", "activity", "a photo of tourists sightseeing", "a famous landmark", "people taking photos of a monument"),
    _t("road trip", "activity", "a photo of a road trip", "a view through a car windshield on the highway", "a car on a scenic road"),
    _t("flying", "activity", "a photo of the view from an airplane window", "an airport departure hall", "inside an airplane cabin"),
    _t("train ride", "activity", "a photo of a train ride", "the view from a train window", "a train platform"),
    _t("walk in the city", "activity", "a photo of people walking in a city", "friends walking down a street"),
    _t("walk in nature", "activity", "a photo of people walking in a forest", "a walk along a path in nature", "a walk by the sea"),
    _t("studying", "activity", "a photo of people studying", "a study group at a library", "a laptop and notes on a desk"),
    _t("work", "activity", "a photo of an office", "colleagues at a meeting", "a workplace"),
    _t("moving", "activity", "a photo of moving house", "moving boxes in an empty apartment"),
    _t("diy", "activity", "a photo of home renovation", "someone painting a wall", "tools and construction work"),
    _t("gardening", "activity", "a photo of gardening", "a person planting in a garden", "a vegetable garden"),
    _t("photoshoot", "activity", "a photo of a photoshoot", "a person posing for a photographer", "a studio portrait with lighting"),
    _t("filming", "activity", "a photo of a film camera on a tripod", "a person filming with a video camera", "a film set"),
    _t("recording", "activity", "a photo of a recording studio", "a microphone in a studio", "a person recording vocals with headphones"),
    _t("karaoke", "activity", "a photo of karaoke", "a person singing into a microphone at a bar"),
    _t("dancing", "activity", "a photo of people dancing", "a dance floor"),
    _t("cabin trip", "activity", "a photo of a cabin trip", "a wooden cabin in the mountains", "friends at a cabin in winter", "a cabin by a lake"),
    _t("sunbathing", "activity", "a photo of sunbathing", "people lying in the sun on a lawn"),
    _t("bonfire", "activity", "a photo of a bonfire", "people around a bonfire on the beach", "midsummer bonfire"),
    # ---------------------------------------------------------------- scenes
    _t("beach", "scene", "a photo of a beach", "sand and sea at a beach"),
    _t("mountains", "scene", "a photo of a mountain landscape", "mountain peaks", "a view from a mountain top"),
    _t("forest", "scene", "a photo of a forest", "trees in a forest", "a forest path"),
    _t("lake", "scene", "a photo of a lake", "a calm lake with reflections"),
    _t("fjord", "scene", "a photo of a fjord", "a norwegian fjord with steep mountains", "the sea seen from the coast"),
    _t("waterfall", "scene", "a photo of a waterfall"),
    _t("river", "scene", "a photo of a river", "a stream in nature"),
    _t("snow", "scene", "a photo of a snowy landscape", "snow covered trees", "a snowy street"),
    _t("sunset", "scene", "a photo of a sunset", "a sunrise", "an orange sky at dusk"),
    _t("northern lights", "scene", "a photo of the northern lights", "aurora borealis in the night sky"),
    _t("night sky", "scene", "a photo of the night sky with stars", "the milky way"),
    _t("fireworks", "scene", "a photo of fireworks"),
    _t("city at night", "scene", "a photo of a city street at night", "city lights at night", "neon signs at night"),
    _t("city street", "scene", "a photo of a city street in daytime", "buildings on a city street", "a city square"),
    _t("old town", "scene", "a photo of an old town with historic buildings", "a cobblestone street with old houses"),
    _t("park", "scene", "a photo of a park", "a lawn with trees in a city park", "people in a park on a sunny day"),
    _t("harbour", "scene", "a photo of a harbour", "boats in a marina", "a pier by the sea"),
    _t("countryside", "scene", "a photo of the countryside", "fields and farms", "a rural landscape"),
    _t("island", "scene", "a photo of a small island", "rocky islands in the sea", "skerries"),
    _t("rooftop", "scene", "a photo of a rooftop terrace", "a view over the city from a rooftop"),
    _t("balcony", "scene", "a photo of a balcony", "people on a balcony"),
    _t("garden", "scene", "a photo of a garden", "a backyard with a lawn"),
    _t("lawn", "scene", "a photo of a lawn", "green grass in a park", "a grass field"),
    _t("path", "scene", "a photo of a gravel path", "a walking path between trees", "a footpath in a residential area"),
    _t("terrace", "scene", "a photo of a wooden terrace", "a patio with outdoor furniture", "a deck outside a house"),
    _t("restaurant", "scene", "a photo of a restaurant", "a restaurant table with plates", "people at a restaurant"),
    _t("cafe", "scene", "a photo of a cafe", "a coffee shop interior"),
    _t("bar", "scene", "a photo of a bar", "a pub interior", "people at a bar counter"),
    _t("living room", "scene", "a photo of a living room", "a sofa and a tv in a living room"),
    _t("kitchen", "scene", "a photo of a kitchen"),
    _t("bedroom", "scene", "a photo of a bedroom", "a bed in a bedroom"),
    _t("bathroom", "scene", "a photo of a bathroom", "a bathroom mirror"),
    _t("hotel room", "scene", "a photo of a hotel room", "a hotel bed"),
    _t("airport", "scene", "a photo of an airport", "an airport terminal"),
    _t("stadium", "scene", "a photo of a stadium", "a large arena"),
    _t("school", "scene", "a photo of a school", "a classroom", "a university campus"),
    _t("church", "scene", "a photo of a church", "a cathedral interior"),
    _t("castle", "scene", "a photo of a castle", "a fortress"),
    _t("amusement park", "scene", "a photo of an amusement park", "a roller coaster", "a ferris wheel"),
    _t("zoo", "scene", "a photo of a zoo", "animals in an enclosure"),
    _t("ski resort", "scene", "a photo of a ski resort", "a ski lift", "a chairlift over a slope"),
    _t("swimming pool", "scene", "a photo of a swimming pool", "people in a pool"),
    _t("tent", "scene", "a photo of a tent", "inside a tent"),
    _t("rain", "scene", "a photo of rain", "people with umbrellas in the rain", "a rainy street"),
    _t("underwater", "scene", "an underwater photo", "snorkeling", "diving underwater"),
    _t("aerial view", "scene", "an aerial photo taken by a drone", "a bird's eye view of a landscape"),
    # ---------------------------------------------------------------- food & drink
    _t("food", "food", "a photo of food on a plate", "a meal", "a dish at a restaurant"),
    _t("pizza", "food", "a photo of a pizza"),
    _t("burger", "food", "a photo of a burger", "a hamburger and fries"),
    _t("sushi", "food", "a photo of sushi"),
    _t("taco", "food", "a photo of tacos", "taco friday"),
    _t("hot dog", "food", "a photo of a hot dog", "a pølse in a bun"),
    _t("waffles", "food", "a photo of waffles", "norwegian heart waffles with jam"),
    _t("cake", "food", "a photo of a cake", "a slice of cake", "cake and pastries"),
    _t("ice cream", "food", "a photo of ice cream", "an ice cream cone"),
    _t("breakfast", "food", "a photo of breakfast", "eggs and toast", "a breakfast table"),
    _t("seafood", "food", "a photo of seafood", "shrimp and crab", "a seafood platter"),
    _t("kebab", "food", "a photo of a kebab", "a kebab wrap late at night"),
    _t("snacks", "food", "a photo of snacks", "chips and dip", "candy"),
    _t("beer", "drink", "a photo of a beer", "a pint of beer", "a glass of beer with foam", "a can of beer", "beer bottles on a table", "a tray of beers", "a person drinking beer from a can"),
    _t("wine", "drink", "a photo of wine", "a glass of red wine", "a bottle of wine", "white wine glasses"),
    _t("cocktail", "drink", "a photo of a cocktail", "an aperol spritz", "a mixed drink with ice"),
    _t("shots", "drink", "a photo of shot glasses", "people taking shots"),
    _t("champagne", "drink", "a photo of champagne", "a champagne bottle", "prosecco glasses"),
    _t("spirits", "drink", "a photo of a bottle of vodka", "a bottle of whisky", "a bottle of liquor", "aquavit"),
    _t("soda", "drink", "a photo of a soda can", "a cola", "a bottle of soft drink"),
    _t("energy drink", "drink", "a photo of an energy drink can", "a can of monster energy", "a can of red bull", "a person drinking an energy drink"),
    _t("tea", "drink", "a photo of a cup of tea"),
    # ---------------------------------------------------------------- objects
    _t("guitar", "object", "a photo of a guitar", "an electric guitar", "an acoustic guitar", "a bass guitar"),
    _t("synthesizer", "object", "a photo of a synthesizer", "a keyboard instrument", "a piano"),
    _t("microphone", "object", "a photo of a microphone"),
    _t("vinyl records", "object", "a photo of vinyl records", "a record player"),
    _t("car", "object", "a photo of a car", "a parked car"),
    _t("motorcycle", "object", "a photo of a motorcycle", "a moped"),
    _t("bicycle", "object", "a photo of a bicycle"),
    _t("boat", "object", "a photo of a boat", "a sailboat", "a motorboat"),
    _t("skis", "object", "a photo of skis", "ski equipment"),
    _t("skateboard", "object", "a photo of a skateboard", "skateboarding"),
    _t("camera", "object", "a photo of a camera", "an analog film camera"),
    _t("flowers", "object", "a photo of flowers", "a bouquet of flowers"),
    _t("present", "object", "a photo of wrapped presents", "a gift with a bow"),
    _t("balloons", "object", "a photo of balloons"),
    _t("flag", "object", "a photo of a norwegian flag", "flags"),
    _t("artwork", "object", "a photo of a painting", "a drawing", "street art graffiti"),
    _t("tattoo", "object", "a photo of a tattoo", "getting a tattoo"),
    _t("clothes", "object", "a photo of clothes", "an outfit", "shoes"),
    _t("plants", "object", "a photo of houseplants", "a plant in a pot"),
    _t("book", "object", "a photo of a book", "a bookshelf"),
    _t("sign", "object", "a photo of a sign", "a poster", "a menu board"),
    # ---------------------------------------------------------------- animals
    _t("dog", "animal", "a photo of a dog", "a puppy"),
    _t("cat", "animal", "a photo of a cat", "a kitten"),
    _t("horse", "animal", "a photo of a horse"),
    _t("bird", "animal", "a photo of a bird", "seagulls", "ducks"),
    _t("cows and sheep", "animal", "a photo of cows", "a photo of sheep", "farm animals", "goats"),
    _t("wild animal", "animal", "a photo of a wild animal", "a deer", "a moose", "a fox", "a reindeer"),
    _t("fish", "animal", "a photo of a fish", "an aquarium"),
    # ---------------------------------------------------------------- people composition
    _t("selfie", "people", "a selfie", "a close-up selfie of a person's face", "a selfie of two people"),
    _t("group photo", "people", "a group photo", "a group of friends posing for a photo", "a large group of people smiling at the camera"),
    _t("portrait", "people", "a portrait of one person", "a close-up of a person's face"),
    _t("couple", "people", "a photo of a couple", "two people hugging", "a couple kissing"),
    _t("baby", "people", "a photo of a baby", "a toddler"),
    _t("kids", "people", "a photo of children playing", "kids"),
    _t("crowd", "people", "a photo of a crowd", "a big crowd of people"),
    _t("mirror selfie", "people", "a mirror selfie", "a person photographing themselves in a mirror"),
    # ---------------------------------------------------------------- mundane
    _t("computer screen", "mundane", "a photo of a computer monitor", "a photo of a laptop screen", "a photo of a tv screen", "software on a computer screen", "a photo of a screen showing a video"),
    _t("desk", "mundane", "a photo of a desk with a computer", "a home office", "a messy desk with cables"),
    _t("music software", "mundane", "a photo of a screen showing a digital audio workstation", "a computer screen with music production software", "a screen with audio waveforms and tracks"),
    _t("empty room", "mundane", "a photo of an empty room", "a photo of a wall", "a photo of a ceiling", "a photo of a floor"),
    _t("groceries", "mundane", "a photo of groceries", "a shop shelf", "a supermarket aisle", "a price tag"),
    _t("package", "mundane", "a photo of a cardboard package", "a parcel", "a delivery box"),
    _t("parking", "mundane", "a photo of a parking lot", "a parking ticket machine"),
    _t("whiteboard", "mundane", "a photo of a whiteboard", "handwritten notes on paper", "a notebook page"),
    _t("laundry", "mundane", "a photo of laundry", "a washing machine", "clothes drying"),
    _t("mess", "mundane", "a photo of a messy room", "trash", "dirty dishes"),
    _t("cables", "mundane", "a photo of cables", "an electronic device", "a router", "a charger"),
    # ---------------------------------------------------------------- utility
    _t("screenshot", "utility", "a screenshot of a phone", "a screenshot of an app", "a screenshot of a website", "a screen capture with a status bar"),
    _t("chat", "utility", "a screenshot of a text message conversation", "a chat app screenshot", "a messenger conversation"),
    _t("document", "utility", "a photo of a document", "a scanned document", "a page of printed text", "a form"),
    _t("receipt", "utility", "a photo of a receipt", "an invoice", "a bill"),
    _t("meme", "utility", "an internet meme with text", "a funny image with caption text", "a cartoon with a joke"),
    _t("map", "utility", "a screenshot of a map", "a map with a route", "google maps"),
    _t("qr code", "utility", "a photo of a qr code", "a barcode", "a ticket with a qr code"),
    _t("whiteboard photo", "utility", "a photo of a whiteboard with writing", "a slide from a presentation", "a photo of a lecture slide"),
    # ---------------------------------------------------------------- quality anchors (not surfaced)
    _t("camera photo", "quality", "a photo taken with a phone camera", "a photograph of real life"),
    _t("beautiful photo", "quality", "a beautiful photo", "a stunning, well composed photograph", "a great photo with nice light"),
    _t("accidental photo", "quality", "a blurry accidental photo", "a dark, blurry, badly framed photo", "a photo of nothing taken by mistake"),
)

KEYS: tuple[str, ...] = tuple(t.key for t in VOCAB)
INDEX: dict[str, int] = {t.key: i for i, t in enumerate(VOCAB)}
CAT_OF: dict[str, str] = {t.key: t.cat for t in VOCAB}

# Utility rule (§6.3): the top utility tag must be clearly present *and* beat the "real photo" anchor on raw
# cosine, so a party photo that merely looks graphic never becomes a screenshot.
UTILITY_KEYS = tuple(t.key for t in VOCAB if t.cat == "utility")
UTILITY_SCORE = 0.6           # calibrated score (z >= 2.5), see calibrate.py; every sampled hit at this level was real
CAMERA_ANCHOR = "camera photo"

# What gets written to blobs.tags: the top-N by calibrated score, plus everything at/above PRESENT.
TAGS_TOP = 8
TAG_PRESENT = 0.6            # mirrored in packages/shared/src/constants.ts TAGS.present


def check() -> None:
    """Sanity: unique keys, known categories. Called by the tests."""
    assert len(KEYS) == len(set(KEYS)), "duplicate tag keys"
    for t in VOCAB:
        assert t.cat in CATEGORIES, f"{t.key}: unknown category {t.cat}"
        assert t.prompts, f"{t.key}: no prompts"
