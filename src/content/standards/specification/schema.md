---
title: Field schema
summary: The fields every polygon layer carries, with their types. Each layer repeats its parents' fields, so it works on its own.
order: 4
---

Each polygon layer at level L carries all of the following fields. Fields whose names contain *{N}* repeat for every level from 0 through L, making each layer self-contained: upper-level units can be derived by dissolving on the embedded parent fields without reference to any other layer. All other fields except *area\_sqkm* and *level* are constant across all rows within a layer.

| Field | Type | Description |
| :---- | :---- | :---- |
| *adm{N}\_pcode* | String | OCHA P-code. Format: ISO3 country prefix, dot delimiter, 3-digit zero-padded integer groups (e.g., *AFG*, *AFG.001*, *AFG.001.012*). See Format Standard above. |
| *adm{N}\_name* | String | Official romanized name. The language is declared in *lang*. Not null. |
| *adm{N}\_name1* | String | Alternate-language name. The language is declared in *lang1*. Null if *lang1* is null. |
| *adm{N}\_name2* | String | Alternate-language name. The language is declared in *lang2*. Null if *lang2* is null. |
| *adm{N}\_name3* | String | Alternate-language name. The language is declared in *lang3*. Null if *lang3* is null. |
| *adm{N}\_type* | String*\-50* | Administrative unit type drawn from a controlled taxonomy. Values in the taxonomy may be translated into local languages. |
| *adm{N}\_srcid* | String *\-20* | Source-assigned code (government, GADM, OSM, or other). Null where no source code exists. |
| *version* | Integer | Release version, identical across all rows and all levels for the same dataset release (e.g., *1*). |
| *updated* | Date | Date of last name / metadata change to the dataset; empty on release and populated when a minor change has been made. |
| *valid\_from* | Date | Date from which the dataset is valid for humanitarian use. Automatically set when a dataset is added to the global central registry. |
| *valid\_to* | Date | End of validity period. Null for the current release. |
| *lang* | String | BCP 47 language code for *adm{N}\_name*. Must identify a romanized script. |
| *lang1*–*lang3* | String | BCP 47 language code for *adm{N}\_name1*–*name3*. Null if the corresponding name column is unused. |
| *area\_sqkm* | Float | Polygon area in square kilometers, computed in an equal-area projection. WGS84 area is not used. |
| *level* | Integer | Administrative level of the unit. A location without units at the layer's level repeats its deepest units, copying their fields down, and area no unit covers is an admin 0 unit (e.g., *level* *1* or *0* in the admin 2 layer). |
| *latest* | Boolean / *Integer* | Virtual field: true where *valid\_to* is null. |

Language codes MUST be valid BCP 47 tags. For each language, look up its entry in the IANA Language Subtag Registry (Type: language). If that entry defines a 2-letter Subtag (ISO 639-1), it MUST be used. A 3-letter Subtag (ISO 639-2/639-3) MUST NOT be used unless no 2-letter Subtag exists for that language.
