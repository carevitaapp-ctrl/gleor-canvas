# Earring Production Standard 2.0.0

New implemented standard; no claim to recover version 1.7.0. Applies when RAW source analysis and Product Truth identify an earring. Unknown/conflicting category cannot silently choose a less restrictive category.

The immutable visible identity includes:

| Field | Lock/comparison meaning |
| --- | --- |
| visible_stone_count | Exact visible count; integer; agrees with Product Truth |
| stone_size_hierarchy | Relative sizes/order; no enlargement or regularization |
| stone_spacing | Relative gaps/layout remain unchanged |
| prong_setting_rhythm | Visible prong/setting count, arrangement and repetition |
| stone_bearing_rail_width | Visible rail width relative to stones/product |
| gallery_opening_count_shape_spacing | Visible gallery count, shape and layout |
| hinge_clasp_relationship | Relative position, connection and geometry |
| post_pin_relationship | Visible attachment, position and orientation |
| inner_opening_proportions | Visible opening shape and proportions |
| rail_curvature | Visible curvature profile |
| bottom_geometry | Visible lower termination/shape |
| metal_thickness_family | Visible thickness relationships, not inferred alloy |
| visible_seams_joints | Visible connection/continuity details |

General silhouette and proportions are also required (15 unique fields total). Every field records status, value, evidence and confidence; no hidden observation is fabricated. NOT_VISIBLE records absence of observation rather than absence of a physical component. UNKNOWN blocks production. A source permitting only preservation cannot authorize the current generative earring renderer: no alternative pipeline is invented to avoid rejection.

A reconstruction request needs every required feature KNOWN at confidence >= 0.95, complete sufficient source, consistent RAW Product Truth, passed Structure Check and Macro Inspection, and an immutable lock. The current GPT Image renderer is reused only after this authorization. The candidate then must match every locked field with zero permitted structural change, preserve registered finish identity/revision, pass existing A/B checks and RELEASE_GATE, and receive a publication capability.

No requirement is satisfied by a prompt alone. A reconstruction that looks more polished but changes any locked feature is rejected. Comparison confidence and MATCH labels remain model assessments; local mocked tests validate control flow, not real-world evaluator accuracy.
