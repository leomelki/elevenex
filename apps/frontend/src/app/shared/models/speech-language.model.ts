/**
 * ISO-639-1 codes Whisper's multilingual models are trained on (from the
 * tokenizer's own language table). Used for both the local engine and the
 * cloud providers, which all key `language` off the same code.
 */
export const SPEECH_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Chinese' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'ru', label: 'Russian' },
  { code: 'ko', label: 'Korean' },
  { code: 'fr', label: 'French' },
  { code: 'ja', label: 'Japanese' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'tr', label: 'Turkish' },
  { code: 'pl', label: 'Polish' },
  { code: 'ca', label: 'Catalan' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ar', label: 'Arabic' },
  { code: 'sv', label: 'Swedish' },
  { code: 'it', label: 'Italian' },
  { code: 'id', label: 'Indonesian' },
  { code: 'hi', label: 'Hindi' },
  { code: 'fi', label: 'Finnish' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'he', label: 'Hebrew' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'el', label: 'Greek' },
  { code: 'ms', label: 'Malay' },
  { code: 'cs', label: 'Czech' },
  { code: 'ro', label: 'Romanian' },
  { code: 'da', label: 'Danish' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'ta', label: 'Tamil' },
  { code: 'no', label: 'Norwegian' },
  { code: 'th', label: 'Thai' },
  { code: 'ur', label: 'Urdu' },
  { code: 'hr', label: 'Croatian' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'lt', label: 'Lithuanian' },
  { code: 'la', label: 'Latin' },
  { code: 'mi', label: 'Maori' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'cy', label: 'Welsh' },
  { code: 'sk', label: 'Slovak' },
  { code: 'te', label: 'Telugu' },
  { code: 'fa', label: 'Persian' },
  { code: 'lv', label: 'Latvian' },
  { code: 'bn', label: 'Bengali' },
  { code: 'sr', label: 'Serbian' },
  { code: 'az', label: 'Azerbaijani' },
  { code: 'sl', label: 'Slovenian' },
  { code: 'kn', label: 'Kannada' },
  { code: 'et', label: 'Estonian' },
  { code: 'mk', label: 'Macedonian' },
  { code: 'br', label: 'Breton' },
  { code: 'eu', label: 'Basque' },
  { code: 'is', label: 'Icelandic' },
  { code: 'hy', label: 'Armenian' },
  { code: 'ne', label: 'Nepali' },
  { code: 'mn', label: 'Mongolian' },
  { code: 'bs', label: 'Bosnian' },
  { code: 'kk', label: 'Kazakh' },
  { code: 'sq', label: 'Albanian' },
  { code: 'sw', label: 'Swahili' },
  { code: 'gl', label: 'Galician' },
  { code: 'mr', label: 'Marathi' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'si', label: 'Sinhala' },
  { code: 'km', label: 'Khmer' },
  { code: 'sn', label: 'Shona' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'so', label: 'Somali' },
  { code: 'af', label: 'Afrikaans' },
  { code: 'oc', label: 'Occitan' },
  { code: 'ka', label: 'Georgian' },
  { code: 'be', label: 'Belarusian' },
  { code: 'tg', label: 'Tajik' },
  { code: 'sd', label: 'Sindhi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'am', label: 'Amharic' },
  { code: 'yi', label: 'Yiddish' },
  { code: 'lo', label: 'Lao' },
  { code: 'uz', label: 'Uzbek' },
  { code: 'fo', label: 'Faroese' },
  { code: 'ht', label: 'Haitian Creole' },
  { code: 'ps', label: 'Pashto' },
  { code: 'tk', label: 'Turkmen' },
  { code: 'nn', label: 'Nynorsk' },
  { code: 'mt', label: 'Maltese' },
  { code: 'sa', label: 'Sanskrit' },
  { code: 'lb', label: 'Luxembourgish' },
  { code: 'my', label: 'Myanmar' },
  { code: 'bo', label: 'Tibetan' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'mg', label: 'Malagasy' },
  { code: 'as', label: 'Assamese' },
  { code: 'tt', label: 'Tatar' },
  { code: 'haw', label: 'Hawaiian' },
  { code: 'ln', label: 'Lingala' },
  { code: 'ha', label: 'Hausa' },
  { code: 'ba', label: 'Bashkir' },
  { code: 'jw', label: 'Javanese' },
  { code: 'su', label: 'Sundanese' },
  { code: 'yue', label: 'Cantonese' },
];

const SPEECH_LANGUAGE_CODES = new Set(
  SPEECH_LANGUAGES.map((language) => language.code),
);

/**
 * The language this machine is set up for, mapped down to a code Whisper
 * recognises. Falls back to English when the OS locale is unset or is not
 * one of the languages above (e.g. a regional variant with no ISO-639-1
 * entry of its own).
 */
export function detectComputerLanguageCode(): string {
  const locales =
    typeof navigator === 'undefined'
      ? []
      : (navigator.languages?.length ? navigator.languages : [navigator.language]);

  for (const locale of locales) {
    const code = locale?.split('-')[0]?.toLowerCase();
    if (code && SPEECH_LANGUAGE_CODES.has(code)) {
      return code;
    }
  }
  return 'en';
}
