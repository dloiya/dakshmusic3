import unittest

from validate_audio import artist_similarity, normalize, similarity


class AudioIdentityTests(unittest.TestCase):
    def test_normalize_removes_diacritics_and_features(self):
        self.assertEqual(normalize("Beyoncé (feat. Jay-Z)"), "beyonce")

    def test_exact_title_matches(self):
        self.assertEqual(similarity("Blinding Lights", "Blinding Lights"), 1.0)

    def test_title_variation_is_still_strong(self):
        self.assertGreaterEqual(similarity("Blinding Lights", "Blinding Lights Official Audio"), 0.80)

    def test_wrong_title_is_not_a_match(self):
        self.assertLess(similarity("Blinding Lights", "Save Your Tears"), 0.80)

    def test_contributor_heavy_artist_metadata_matches_primary_artist(self):
        self.assertGreaterEqual(
            artist_similarity(
                "Ninajirachi",
                "Ninajirachi, Nina Wilson, Benjamin Michael Lee",
            ),
            0.90,
        )


if __name__ == "__main__":
    unittest.main()
